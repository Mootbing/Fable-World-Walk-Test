import * as THREE from "three";
import { LANE, STATE_FLAG } from "../sim/entityLayout";

/**
 * The visible player body: rigid low-poly parts swung procedurally from the
 * sim's gait phase (entity-0 lanes). This is the prototype of the ped
 * archetype — PR7 generalizes the same part scheme into instanced pools.
 *
 * Pivot scheme: each limb is a Group positioned at its joint (shoulder/hip)
 * with the mesh offset so rotation swings the limb naturally.
 */
export class PlayerAvatar {
  readonly group = new THREE.Group();

  private torso: THREE.Group;
  private leftArm: THREE.Group;
  private rightArm: THREE.Group;
  private leftLeg: THREE.Group;
  private rightLeg: THREE.Group;
  private quat = new THREE.Quaternion();

  // Proportions for a ~1.8m figure (feet at group origin).
  private static readonly LEG = 0.8;
  private static readonly TORSO = 0.62;
  private static readonly ARM = 0.62;

  constructor() {
    const skin = new THREE.MeshLambertMaterial({ color: 0xc9a07a });
    const shirt = new THREE.MeshLambertMaterial({ color: 0x3b6ea5 });
    const pants = new THREE.MeshLambertMaterial({ color: 0x2d3138 });

    const limb = (w: number, len: number, mat: THREE.Material) => {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, len, w), mat);
      mesh.position.y = -len / 2;
      g.add(mesh);
      return g;
    };

    const hip = PlayerAvatar.LEG;
    const shoulder = hip + PlayerAvatar.TORSO - 0.04;

    this.torso = new THREE.Group();
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.42, PlayerAvatar.TORSO, 0.24), shirt);
    chest.position.y = hip + PlayerAvatar.TORSO / 2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.26), skin);
    head.position.y = shoulder + 0.2;
    this.torso.add(chest, head);

    this.leftArm = limb(0.12, PlayerAvatar.ARM, shirt);
    this.leftArm.position.set(0.28, shoulder, 0);
    this.rightArm = limb(0.12, PlayerAvatar.ARM, shirt);
    this.rightArm.position.set(-0.28, shoulder, 0);
    this.leftLeg = limb(0.16, PlayerAvatar.LEG, pants);
    this.leftLeg.position.set(0.11, hip, 0);
    this.rightLeg = limb(0.16, PlayerAvatar.LEG, pants);
    this.rightLeg.position.set(-0.11, hip, 0);

    this.group.add(this.torso, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);
    this.group.visible = false;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  set visible(v: boolean) {
    this.group.visible = v;
  }

  /**
   * Pose from the entity-0 record. `eyeY` is the sim's player y (eye
   * height); feet sit ~1.7m below it.
   */
  update(entities: Float32Array, entitiesU32: Uint32Array, time: number): void {
    if (!this.group.visible || entities.length < 16) return;
    const x = entities[LANE.posX];
    const y = entities[LANE.posY];
    const z = entities[LANE.posZ];
    const speed = entities[LANE.speed];
    const phase = entities[LANE.animPhase];
    const punch = entities[LANE.aux0];
    const grounded = (entitiesU32[LANE.stateFlags] & STATE_FLAG.grounded) !== 0;

    this.group.position.set(x, y - 1.7, z);
    this.quat.set(
      entities[LANE.quatX],
      entities[LANE.quatY],
      entities[LANE.quatZ],
      entities[LANE.quatW],
    );
    this.group.quaternion.copy(this.quat);

    if (punch > 0) {
      // Jab: right arm drives forward, slight torso twist.
      const t = Math.sin(punch * Math.PI);
      this.rightArm.rotation.x = -1.7 * t;
      this.leftArm.rotation.x = 0.3 * t;
      this.leftLeg.rotation.x = 0;
      this.rightLeg.rotation.x = 0;
      this.torso.position.y = 0;
      return;
    }
    if (!grounded) {
      // Airborne: tuck legs, raise arms slightly.
      this.leftLeg.rotation.x = -0.5;
      this.rightLeg.rotation.x = -0.5;
      this.leftArm.rotation.x = -0.4;
      this.rightArm.rotation.x = -0.4;
      this.torso.position.y = 0;
    } else if (speed > 0.05) {
      const amp = 0.45 + 0.5 * Math.min(1, speed / 5.5);
      const swing = Math.sin(phase * Math.PI * 2) * amp;
      this.leftLeg.rotation.x = swing;
      this.rightLeg.rotation.x = -swing;
      this.leftArm.rotation.x = -swing * 0.7;
      this.rightArm.rotation.x = swing * 0.7;
      this.torso.position.y = Math.abs(Math.sin(phase * Math.PI * 2)) * 0.03;
    } else {
      // Idle: relax, slow breathing bob.
      this.leftLeg.rotation.x = 0;
      this.rightLeg.rotation.x = 0;
      this.leftArm.rotation.x = Math.sin(time * 1.8) * 0.03;
      this.rightArm.rotation.x = -Math.sin(time * 1.8) * 0.03;
      this.torso.position.y = Math.sin(time * 1.8) * 0.012;
    }
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
  }
}
