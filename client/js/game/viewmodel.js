// First-person arms and held items, rendered in their own scene on top of the world.
import * as THREE from 'three';
import { potatoModel, chickenModel, itemModel } from './models.js';
import { weaponModel, MUZZLE, MUZZLE_Y } from './weapons.js';

const SKIN = 0xffcc99;
const VM_SCALE = 0.62; // first-person weapon scale

// Where the hands go on each gun (gun-local units, before VM_SCALE):
// r = trigger hand on the grip, l = support hand, rot = arm rotations, sight = ADS sight height
const HOLD = {
  pistol: { r: [0, -0.135, 0.05], l: null, rr: [1.3, 0.25, 0], sight: 0.105 },
  revolver: { r: [0, -0.12, 0.09], l: null, rr: [1.3, 0.25, 0], sight: 0.104 },
  smg: { r: [0, -0.11, 0.035], l: [0, -0.06, -0.25], rr: [1.25, 0.25, 0], lr: [1.25, -0.2, 0], sight: 0.124 },
  shotgun: { r: [0, -0.08, 0.1], l: [0, 0.025, -0.36], rr: [1.2, 0.25, 0], lr: [1.25, -0.2, 0], sight: 0.115 },
  rifle: { r: [0, -0.1, 0.065], l: [0, 0.04, -0.33], rr: [1.25, 0.25, 0], lr: [1.25, -0.2, 0], sight: 0.16 },
  sniper: { r: [0, -0.09, 0.075], l: [0, 0.01, -0.4], rr: [1.25, 0.25, 0], lr: [1.25, -0.2, 0], sight: 0.165 },
  blaster: { r: [0, -0.1, 0.065], l: [0, 0.01, -0.22], rr: [1.25, 0.25, 0], lr: [1.25, -0.2, 0], sight: 0.14 },
};
// arms are slimmer while holding a gun so they never cover it
const GUN_ARM = 0.5;

let _armGeo = null;

export class ViewModel {
  constructor(sleeveColor) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6a6a90, 1.9));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
    sun.position.set(0.5, 1, 0.3);
    const rim = new THREE.DirectionalLight(0xbfd8ff, 0.9); // edge light so dark guns keep their shape
    rim.position.set(-1, 0.4, -1);
    this.scene.add(sun, rim);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // plain blocky skin-coloured arms (flat shading keeps the clean block look)
    const skin = new THREE.MeshLambertMaterial({ color: SKIN });
    this.sleeveMat = new THREE.MeshLambertMaterial({ color: sleeveColor || '#4cc9f0' }); // kept for setSleeve()
    if (!_armGeo) _armGeo = new THREE.BoxGeometry(0.1, 0.1, 0.6).translate(0, 0, 0.27);
    // An arm is a group whose origin is the front end of the block; the arm runs
    // back along +Z and is tilted (via the group's rotation) down out of the screen.
    const mkArm = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(_armGeo, skin));
      return g;
    };
    this.armR = mkArm();
    this.armL = mkArm();
    this.root.add(this.armR, this.armL);
    this.itemAnchor = new THREE.Group();
    this.root.add(this.itemAnchor);
    this.item = null;
    this.state = 'fists';
    this.weaponType = null;
    this.skin = null;

    // muzzle flash
    const flashTex = makeFlashTexture();
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffd27a, transparent: true, depthTest: false, blending: THREE.AdditiveBlending }));
    this.flash.scale.set(0.25, 0.25, 1);
    this.flash.visible = false;
    this.itemAnchor.add(this.flash);

    this.t = 0;
    this.bobPhase = 0;
    this.swayX = 0; this.swayY = 0;
    this.recoil = 0;
    this.punchT = 0; this.punchSide = 1;
    this.switchT = 0;
    this.reloadT = 0; this.reloadDur = 1;
    this.useT = 0;
    this.landT = 0;
    this.ads = 0;
    this.healT = 0;
    this.visible = true;
  }

  setSleeve(color) { this.sleeveMat.color.set(color); }

  setResolution(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  // kind: 'fists' | 'weapon' | 'potato' | 'chicken'
  setHeld(kind, weaponType = null, skin = null) {
    if (kind === this.state && weaponType === this.weaponType && skin === this.skin) return;
    if (this.item) { this.itemAnchor.remove(this.item); this.item = null; }
    this.state = kind; this.weaponType = weaponType; this.skin = skin;
    // with a gun the hands ride on the gun (so they follow recoil and reloads); otherwise on the root
    const parent = kind === 'weapon' && weaponType ? this.itemAnchor : this.root;
    if (this.armR.parent !== parent) { parent.add(this.armR, this.armL); }
    this.armL.scale.x = -1; // left hand = mirrored right hand
    if (kind === 'weapon' && weaponType) {
      this.item = weaponModel(weaponType, skin);
      this.item.scale.setScalar(VM_SCALE);
      this.flash.position.set(0, (MUZZLE_Y[weaponType] || 0.07) * VM_SCALE, (MUZZLE[weaponType] || -0.4) * VM_SCALE);
    } else if (kind === 'potato') {
      this.item = potatoModel();
      this.item.scale.setScalar(0.3);
      this.item.rotation.y = Math.PI; // googly eyes look back at you
    } else if (kind === 'chicken') {
      this.item = chickenModel();
      this.item.scale.setScalar(0.26);
      this.item.rotation.y = Math.PI * 0.65;
    }
    if (this.item) this.itemAnchor.add(this.item);
    this.switchT = 0.3;
    this.reloadT = 0;
  }

  showHealItem(type) {
    if (this.healItem) { this.root.remove(this.healItem); this.healItem = null; }
    if (type) {
      this.healItem = itemModel('heal', type);
      this.healItem.scale.setScalar(0.5);
      this.root.add(this.healItem);
    }
  }

  punch() { this.punchT = 0.28; this.punchSide = -this.punchSide; }
  use() { this.useT = 0.25; }
  shoot(kick = 0.03) {
    this.recoil = Math.min(0.2, this.recoil + kick * 2.2);
    this.flash.visible = true;
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flashT = 0.05;
  }
  reload(ms) { this.reloadT = ms / 1000; this.reloadDur = ms / 1000; }
  cancelReload() { this.reloadT = 0; }
  land(impact) { this.landT = Math.min(0.25, impact * 0.012); }
  mouse(dx, dy) { this.swayX += dx * 0.00025; this.swayY += dy * 0.00025; }

  update(dt, { speed = 0, grounded = true, sprint = false, ads = false }) {
    this.t += dt;
    const moving = speed > 0.5 && grounded;
    this.bobPhase += dt * (moving ? (sprint ? 12 : 8.5) : 1.4);
    const bobAmp = moving ? (sprint ? 0.028 : 0.016) : 0.004;
    const bx = Math.sin(this.bobPhase) * bobAmp;
    const by = -Math.abs(Math.cos(this.bobPhase)) * bobAmp;
    this.swayX *= Math.pow(0.0015, dt); this.swayY *= Math.pow(0.0015, dt);
    this.swayX = Math.max(-0.06, Math.min(0.06, this.swayX));
    this.swayY = Math.max(-0.06, Math.min(0.06, this.swayY));
    this.recoil *= Math.pow(0.0004, dt);
    this.punchT = Math.max(0, this.punchT - dt);
    this.switchT = Math.max(0, this.switchT - dt);
    this.useT = Math.max(0, this.useT - dt);
    this.landT = Math.max(0, this.landT - dt * 0.8);
    if (this.reloadT > 0) this.reloadT = Math.max(0, this.reloadT - dt);
    if (this.flashT !== undefined) { this.flashT -= dt; if (this.flashT <= 0) this.flash.visible = false; }
    const adsTarget = ads && this.state === 'weapon' && this.reloadT <= 0 ? 1 : 0;
    this.ads += (adsTarget - this.ads) * (1 - Math.exp(-dt * 14)); // frame-rate independent ease
    if (Math.abs(adsTarget - this.ads) < 0.001) this.ads = adsTarget;

    const sw = this.switchT > 0 ? Math.sin((this.switchT / 0.3) * Math.PI) * 0.25 : 0;
    const baseX = -this.swayX - bx * (1 - this.ads * 0.85);
    const baseY = this.swayY + by * (1 - this.ads * 0.85) - sw - this.landT;
    this.root.position.set(0, 0, 0);

    if (this.state === 'weapon') {
      const hold = HOLD[this.weaponType] || HOLD.pistol;
      const rl = this.reloadT > 0 ? Math.sin((1 - this.reloadT / this.reloadDur) * Math.PI) : 0;
      const run = sprint && moving ? 1 : 0;
      const small = this.weaponType === 'pistol' || this.weaponType === 'revolver';
      const hipX = small ? 0.12 : 0.14, hipY = small ? -0.105 : -0.13, hipZ = small ? -0.27 : -0.3;
      // aim down sights: the sight line sits on the screen centre
      const adsX = 0, adsY = -hold.sight * VM_SCALE, adsZ = this.weaponType === 'sniper' ? -0.2 : -0.24;
      const k = this.ads;
      // sway/bob mostly settle while aimed so the sights stay on the crosshair
      const px = hipX + (adsX - hipX) * k + baseX * (1 - k * 0.9);
      const py = hipY + (adsY - hipY) * k + baseY * (1 - k * 0.9) - rl * 0.1 - run * 0.04;
      const pz = hipZ + (adsZ - hipZ) * k + this.recoil * 0.55;
      this.itemAnchor.position.set(px, py, pz);
      this.itemAnchor.rotation.set(
        this.recoil * 1.5 + rl * 0.55 - run * 0.15,
        (run * 0.55 + (1 - k) * 0.035) * (1 - k),
        rl * 0.55 + run * 0.35);
      const S = VM_SCALE;
      // hands come up from below and grab the gun from underneath, so the gun stays in full view
      this.armR.scale.set(GUN_ARM, GUN_ARM, 1);
      this.armR.position.set(hold.r[0] * S, hold.r[1] * S, hold.r[2] * S);
      this.armR.rotation.set(hold.rr[0], hold.rr[1], hold.rr[2]);
      this.armL.visible = !!hold.l;
      if (hold.l) {
        // support hand drops to the magazine while reloading
        this.armL.scale.set(-GUN_ARM, GUN_ARM, 1);
        this.armL.position.set(hold.l[0] * S - rl * 0.02, hold.l[1] * S - rl * 0.05, hold.l[2] * S + rl * 0.12);
        this.armL.rotation.set(hold.lr[0] + rl * 0.2, hold.lr[1], hold.lr[2]);
      }
    } else if (this.state === 'potato' || this.state === 'chicken') {
      this.armR.scale.set(1, 1, 1); this.armL.scale.set(-1, 1, 1);
      const wob = this.state === 'potato' ? Math.sin(this.t * 18) * 0.01 : 0;
      const pass = this.useT > 0 ? Math.sin((this.useT / 0.25) * Math.PI) * 0.25 : 0;
      const ix = this.state === 'chicken' ? 0.16 : 0.12;
      this.itemAnchor.position.set(ix + baseX, -0.27 + baseY + wob, -0.5 - pass);
      this.itemAnchor.rotation.set(0.15, Math.sin(this.t * 1.5) * 0.12, 0);
      this.armR.position.set(0.24 + baseX, -0.25 + baseY, -0.48 - pass);
      this.armR.rotation.set(0.4, 0.35, -0.2);
      this.armL.position.set(0.0 + baseX, -0.25 + baseY, -0.5 - pass);
      this.armL.rotation.set(0.4, -0.35, 0.2);
      this.armL.visible = true;
    } else {
      // fists
      const pk = this.punchT > 0 ? Math.sin((1 - this.punchT / 0.28) * Math.PI) : 0;
      const uk = this.useT > 0 ? Math.sin((1 - this.useT / 0.25) * Math.PI) : 0;
      const breathe = Math.sin(this.t * 2) * 0.006;
      const rPunch = this.punchSide > 0 ? pk : 0, lPunch = this.punchSide < 0 ? pk : 0;
      this.armR.position.set(0.22 - rPunch * 0.14 + baseX, -0.185 + breathe + baseY + rPunch * 0.09 + uk * 0.05, -0.42 - rPunch * 0.3 - uk * 0.18);
      this.armR.rotation.set(0.95 - rPunch * 0.75, 0.3 - rPunch * 0.25, 0);
      this.armL.position.set(-0.22 + lPunch * 0.14 + baseX, -0.185 - breathe + baseY + lPunch * 0.09, -0.42 - lPunch * 0.3);
      this.armL.rotation.set(0.95 - lPunch * 0.75, -0.3 + lPunch * 0.25, 0);
      this.armR.scale.set(1, 1, 1); this.armL.scale.set(-1, 1, 1);
      this.armL.visible = true;
      this.itemAnchor.position.set(0, -10, 0);
    }
    if (this.healItem) {
      this.healT += dt;
      this.healItem.position.set(-0.12 + baseX, -0.22 + baseY + Math.sin(this.healT * 8) * 0.01, -0.42);
      this.healItem.rotation.set(0.4, this.healT, 0);
      this.armL.position.set(-0.12 + baseX, -0.27 + baseY, -0.42);
    }
    if (this.item && this.state === 'potato' && this.item.userData.spark) {
      const s = this.item.userData.spark;
      s.scale.setScalar(0.7 + Math.random() * 0.8);
    }
    this.root.visible = this.visible;
  }
}

function makeFlashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,230,1)');
  g.addColorStop(0.3, 'rgba(255,200,80,0.9)');
  g.addColorStop(1, 'rgba(255,120,0,0)');
  x.fillStyle = g;
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2, r = i % 2 ? 14 : 32;
    x.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
