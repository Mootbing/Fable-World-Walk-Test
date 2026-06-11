//! Directed road graph built incrementally from per-tile OSM polylines
//! (engine/roads.ts clips them to exact tile bounds, so cross-tile
//! stitching falls out of quantized-position node merging).
//!
//! Grade separation: interior vertices only fuse into intersections when
//! referenced by 2+ lines of the SAME level (layer/bridge/tunnel
//! signature), so an overpass crossing a street never creates a phantom
//! 4-way. Endpoints merge by position alone — bridge segments must connect
//! to the plain ways they continue.

use std::collections::HashMap;

/// m/s by class: motorway, trunk, primary, secondary, tertiary, minor, service.
pub const CLASS_SPEEDS: [f64; 7] = [25.0, 22.0, 15.0, 13.0, 11.0, 9.0, 5.0];

#[derive(Clone, Copy, PartialEq)]
pub struct RoadAttr {
    pub class: u8,
    /// 0 both ways, 1 forward-only, -1 reverse-only.
    pub oneway: i8,
    pub bridge: bool,
    pub tunnel: bool,
    pub ramp: bool,
    pub layer: i8,
}

pub fn unpack_attr(a: u32) -> RoadAttr {
    let flags = ((a >> 8) & 0xff) as u8;
    RoadAttr {
        class: (a & 0xff) as u8,
        oneway: if flags & 1 != 0 {
            1
        } else if flags & 2 != 0 {
            -1
        } else {
            0
        },
        bridge: flags & 4 != 0,
        tunnel: flags & 8 != 0,
        ramp: flags & 16 != 0,
        layer: (((a >> 16) & 0xff) as i32 - 8) as i8,
    }
}

fn level_sig(attr: &RoadAttr) -> i16 {
    (attr.layer as i16) << 2 | (attr.bridge as i16) << 1 | attr.tunnel as i16
}

/// 0.5 m quantization grid for node merging.
fn quant(p: (f64, f64)) -> (i64, i64) {
    ((p.0 * 2.0).round() as i64, (p.1 * 2.0).round() as i64)
}

pub struct Node {
    pub x: f64,
    pub z: f64,
    key: (i64, i64),
    /// Outgoing edge ids.
    pub out: Vec<u32>,
    /// Incoming edge ids (approaches — intersection arbitration needs them).
    pub in_edges: Vec<u32>,
    /// Incident (in+out) live edge count; 0 = removable.
    pub incident: u32,
}

pub struct Edge {
    pub from: u32,
    pub to: u32,
    pub class: u8,
    pub speed: f64,
    pub len: f64,
    /// Centerline from→to, world XZ.
    pub points: Vec<(f64, f64)>,
}

pub struct RoadGraph {
    node_ids: HashMap<(i64, i64), u32>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Option<Edge>>,
    free_edges: Vec<u32>,
    tile_edges: HashMap<(i32, i32), Vec<u32>>,
}

impl RoadGraph {
    pub fn new() -> Self {
        RoadGraph {
            node_ids: HashMap::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            free_edges: Vec::new(),
            tile_edges: HashMap::new(),
        }
    }

    pub fn edge_count(&self) -> u32 {
        self.edges.iter().flatten().count() as u32
    }

    pub fn node_count(&self) -> u32 {
        self.nodes.iter().filter(|n| n.incident > 0).count() as u32
    }

    pub fn load_tile(&mut self, tile: (i32, i32), lines: &[(Vec<(f64, f64)>, RoadAttr)]) {
        if self.tile_edges.contains_key(&tile) {
            return;
        }
        // Pass 1: same-level interior reference counts + endpoint positions
        // within this batch (endpoints force splits position-only, in any
        // processing order — T-junctions where a side street ends on a
        // through street's interior vertex).
        let mut refs: HashMap<(i64, i64), Vec<i16>> = HashMap::new();
        let mut endpoints: std::collections::HashSet<(i64, i64)> = std::collections::HashSet::new();
        for (pts, attr) in lines {
            if pts.len() < 2 {
                continue;
            }
            let lvl = level_sig(attr);
            for p in &pts[1..pts.len() - 1] {
                refs.entry(quant(*p)).or_default().push(lvl);
            }
            endpoints.insert(quant(pts[0]));
            endpoints.insert(quant(pts[pts.len() - 1]));
        }

        // Pass 2: split each polyline at intersection vertices, emit
        // directed edges.
        let mut new_edges: Vec<u32> = Vec::new();
        for (pts, attr) in lines {
            if pts.len() < 2 {
                continue;
            }
            let lvl = level_sig(attr);
            let mut splits = vec![0usize];
            for (i, p) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
                let q = quant(*p);
                let same_level = refs.get(&q).map_or(0, |v| v.iter().filter(|l| **l == lvl).count());
                if same_level >= 2 || endpoints.contains(&q) || self.node_ids.contains_key(&q) {
                    splits.push(i);
                }
            }
            splits.push(pts.len() - 1);

            for w in splits.windows(2) {
                let seg = &pts[w[0]..=w[1]];
                let len = polyline_len(seg);
                if len < 0.05 {
                    continue;
                }
                let a = self.get_or_make_node(seg[0]);
                let b = self.get_or_make_node(seg[seg.len() - 1]);
                if a == b && len < 2.0 {
                    continue; // degenerate quantized micro-loop
                }
                let speed = CLASS_SPEEDS[(attr.class as usize).min(CLASS_SPEEDS.len() - 1)];
                if attr.oneway >= 0 {
                    new_edges.push(self.add_edge(a, b, seg.to_vec(), attr.class, speed, len));
                }
                if attr.oneway <= 0 {
                    let mut rev = seg.to_vec();
                    rev.reverse();
                    new_edges.push(self.add_edge(b, a, rev, attr.class, speed, len));
                }
            }
        }
        self.tile_edges.insert(tile, new_edges);
    }

    /// Removes the tile's edges; returns their ids so dependents (traffic)
    /// can drop references.
    pub fn unload_tile(&mut self, tile: (i32, i32)) -> Vec<u32> {
        let Some(ids) = self.tile_edges.remove(&tile) else {
            return Vec::new();
        };
        for id in &ids {
            let id = *id;
            let Some(edge) = self.edges[id as usize].take() else {
                continue;
            };
            let from = &mut self.nodes[edge.from as usize];
            from.out.retain(|e| *e != id);
            from.incident -= 1;
            if from.incident == 0 {
                self.node_ids.remove(&from.key);
            }
            let to = &mut self.nodes[edge.to as usize];
            to.in_edges.retain(|e| *e != id);
            to.incident -= 1;
            if to.incident == 0 {
                self.node_ids.remove(&to.key);
            }
            self.free_edges.push(id);
        }
        ids
    }

    fn union_find(&self) -> Vec<u32> {
        let n = self.nodes.len();
        let mut parent: Vec<u32> = (0..n as u32).collect();
        fn find(parent: &mut [u32], i: u32) -> u32 {
            let mut i = i;
            while parent[i as usize] != i {
                parent[i as usize] = parent[parent[i as usize] as usize];
                i = parent[i as usize];
            }
            i
        }
        for edge in self.edges.iter().flatten() {
            let a = find(&mut parent, edge.from);
            let b = find(&mut parent, edge.to);
            if a != b {
                parent[a as usize] = b;
            }
        }
        for i in 0..n as u32 {
            find(&mut parent, i);
        }
        parent
    }

    /// Largest weakly-connected component's share of total edge LENGTH.
    /// Length-weighted because real OSM tiles contain many tiny genuinely
    /// disconnected service fragments (parking aisles, driveways, piers)
    /// whose node count would mask how well the actual street grid stitched.
    pub fn connectivity(&self) -> f64 {
        let mut parent = self.union_find();
        fn find(parent: &mut [u32], i: u32) -> u32 {
            let mut i = i;
            while parent[i as usize] != i {
                i = parent[i as usize];
            }
            i
        }
        let mut lengths: HashMap<u32, f64> = HashMap::new();
        let mut total = 0.0;
        for edge in self.edges.iter().flatten() {
            let root = find(&mut parent, edge.from);
            *lengths.entry(root).or_insert(0.0) += edge.len;
            total += edge.len;
        }
        if total <= 0.0 {
            return 1.0;
        }
        lengths.values().copied().fold(0.0, f64::max) / total
    }

    /// Component edge-length totals, sorted descending (debug/tests).
    pub fn component_lengths(&self) -> Vec<f64> {
        let mut parent = self.union_find();
        fn find(parent: &mut [u32], i: u32) -> u32 {
            let mut i = i;
            while parent[i as usize] != i {
                i = parent[i as usize];
            }
            i
        }
        let mut lengths: HashMap<u32, f64> = HashMap::new();
        for edge in self.edges.iter().flatten() {
            let root = find(&mut parent, edge.from);
            *lengths.entry(root).or_insert(0.0) += edge.len;
        }
        let mut out: Vec<f64> = lengths.into_values().collect();
        out.sort_by(|a, b| b.total_cmp(a));
        out
    }

    /// Flat [x0,z0,x1,z1,...] segment soup of every live edge polyline.
    pub fn debug_segments(&self) -> Vec<f32> {
        let mut out = Vec::new();
        for edge in self.edges.iter().flatten() {
            for w in edge.points.windows(2) {
                out.push(w[0].0 as f32);
                out.push(w[0].1 as f32);
                out.push(w[1].0 as f32);
                out.push(w[1].1 as f32);
            }
        }
        out
    }

    fn get_or_make_node(&mut self, p: (f64, f64)) -> u32 {
        let q = quant(p);
        if let Some(id) = self.node_ids.get(&q) {
            return *id;
        }
        let id = self.nodes.len() as u32;
        self.nodes.push(Node {
            x: p.0,
            z: p.1,
            key: q,
            out: Vec::new(),
            in_edges: Vec::new(),
            incident: 0,
        });
        self.node_ids.insert(q, id);
        id
    }

    fn add_edge(
        &mut self,
        from: u32,
        to: u32,
        points: Vec<(f64, f64)>,
        class: u8,
        speed: f64,
        len: f64,
    ) -> u32 {
        let edge = Edge {
            from,
            to,
            class,
            speed,
            len,
            points,
        };
        let id = match self.free_edges.pop() {
            Some(id) => {
                self.edges[id as usize] = Some(edge);
                id
            }
            None => {
                self.edges.push(Some(edge));
                (self.edges.len() - 1) as u32
            }
        };
        self.nodes[from as usize].out.push(id);
        self.nodes[from as usize].incident += 1;
        self.nodes[to as usize].in_edges.push(id);
        self.nodes[to as usize].incident += 1;
        id
    }
}

fn polyline_len(pts: &[(f64, f64)]) -> f64 {
    pts.windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attr(class: u8) -> RoadAttr {
        RoadAttr { class, oneway: 0, bridge: false, tunnel: false, ramp: false, layer: 0 }
    }

    #[test]
    fn crossing_streets_make_a_four_way() {
        let mut g = RoadGraph::new();
        // Two streets sharing the vertex (0,0) mid-line.
        g.load_tile(
            (0, 0),
            &[
                (vec![(-100.0, 0.0), (0.0, 0.0), (100.0, 0.0)], attr(5)),
                (vec![(0.0, -100.0), (0.0, 0.0), (0.0, 100.0)], attr(5)),
            ],
        );
        // 4 arms × 2 directions = 8 edges; 5 nodes (4 ends + center).
        assert_eq!(g.edge_count(), 8);
        assert_eq!(g.node_count(), 5);
        assert!((g.connectivity() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn overpass_does_not_fuse_with_street_below() {
        let mut g = RoadGraph::new();
        let mut bridge = attr(0);
        bridge.bridge = true;
        bridge.layer = 1;
        // Both share a coincident interior vertex at (0,0) but at different
        // levels: no intersection may form.
        g.load_tile(
            (0, 0),
            &[
                (vec![(-100.0, 0.0), (0.0, 0.0), (100.0, 0.0)], attr(5)),
                (vec![(0.0, -100.0), (0.0, 0.0), (0.0, 100.0)], bridge),
            ],
        );
        // Each line stays whole: 2 lines × 2 directions = 4 edges, and the
        // two roads form two separate components.
        assert_eq!(g.edge_count(), 4);
        assert!(g.connectivity() < 0.9);
    }

    #[test]
    fn bridge_endpoint_connects_to_plain_way() {
        let mut g = RoadGraph::new();
        let mut bridge = attr(2);
        bridge.bridge = true;
        bridge.layer = 1;
        g.load_tile(
            (0, 0),
            &[
                (vec![(-50.0, 0.0), (0.0, 0.0)], attr(2)),
                (vec![(0.0, 0.0), (50.0, 0.0)], bridge), // continues as bridge
            ],
        );
        assert!((g.connectivity() - 1.0).abs() < 1e-9, "bridge ends must fuse");
    }

    #[test]
    fn oneway_emits_single_direction() {
        let mut g = RoadGraph::new();
        let mut ow = attr(2);
        ow.oneway = 1;
        g.load_tile((0, 0), &[(vec![(0.0, 0.0), (50.0, 0.0)], ow)]);
        assert_eq!(g.edge_count(), 1);
        let e = g.edges[0].as_ref().unwrap();
        assert!(g.nodes[e.from as usize].x < g.nodes[e.to as usize].x);
    }

    #[test]
    fn border_stitching_fuses_clipped_endpoints() {
        let mut g = RoadGraph::new();
        // Tile A contributes up to x=0 (its border), tile B continues from 0.
        g.load_tile((0, 0), &[(vec![(-80.0, 10.0), (0.0, 10.0)], attr(3))]);
        g.load_tile((1, 0), &[(vec![(0.0, 10.0), (80.0, 10.0)], attr(3))]);
        assert_eq!(g.node_count(), 3); // shared border node fused
        assert!((g.connectivity() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn unload_removes_edges_and_orphan_nodes() {
        let mut g = RoadGraph::new();
        g.load_tile((0, 0), &[(vec![(-80.0, 10.0), (0.0, 10.0)], attr(3))]);
        g.load_tile((1, 0), &[(vec![(0.0, 10.0), (80.0, 10.0)], attr(3))]);
        g.unload_tile((1, 0));
        assert_eq!(g.edge_count(), 2); // tile A's two directions remain
        assert_eq!(g.node_count(), 2);
        // Reloading the same tile reproduces the join.
        g.load_tile((1, 0), &[(vec![(0.0, 10.0), (80.0, 10.0)], attr(3))]);
        assert_eq!(g.node_count(), 3);
        assert!((g.connectivity() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn t_junction_splits_the_through_street() {
        let mut g = RoadGraph::new();
        // The side street ENDS on an interior vertex of the through street.
        g.load_tile(
            (0, 0),
            &[
                (vec![(0.0, 50.0), (0.0, 0.0)], attr(5)), // side street first
                (vec![(-100.0, 0.0), (0.0, 0.0), (100.0, 0.0)], attr(4)),
            ],
        );
        // Side street end created a node at (0,0) BEFORE the through street
        // loaded → through street splits there: 2+4 = 6 directed edges.
        assert_eq!(g.edge_count(), 6);
        assert_eq!(g.node_count(), 4);
        assert!((g.connectivity() - 1.0).abs() < 1e-9);
    }
}
