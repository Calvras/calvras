import * as THREE from './vendor/three.module.js';

const petType = new URLSearchParams(location.search).get('pet') || 'ghost';
const button = document.getElementById('robot');
const bubble = document.getElementById('bubble');
let working = false;
let lovedUntil = 0;
let pointer = { x: 0, y: 0 };
window.pet.onState(state => { working = state.working; bubble.textContent = state.text; document.body.dataset.working = String(working); });
let dragState = null;
let dragged = false;
button.addEventListener('click', () => {
  if (dragged) { dragged = false; return; }
  lovedUntil = performance.now() + 1600;
});
button.addEventListener('dblclick', () => window.pet.restore());
window.addEventListener('contextmenu', event => { event.preventDefault(); window.pet.menu(); });
button.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragged = false;
  dragState = { x: event.screenX, y: event.screenY, moved: false };
  button.setPointerCapture(event.pointerId);
});
button.addEventListener('pointermove', event => {
  const box = button.getBoundingClientRect();
  pointer = { x: (event.clientX - box.left) / box.width * 2 - 1, y: (event.clientY - box.top) / box.height * 2 - 1 };
  if (!dragState) return;
  const dx = event.screenX - dragState.x;
  const dy = event.screenY - dragState.y;
  if (!dragState.moved && Math.hypot(dx, dy) < 5) return;
  dragState.moved = true;
  dragged = true;
  dragState.x = event.screenX;
  dragState.y = event.screenY;
  window.pet.drag(dx, dy);
});
button.addEventListener('pointerup', event => {
  if (dragState?.moved) window.pet.dragEnd();
  dragState = null;
  if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
});
button.addEventListener('pointercancel', () => { dragState = null; });
button.addEventListener('pointerleave', () => { pointer = { x: 0, y: 0 }; });

function startGhost() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(button.clientWidth, button.clientHeight);
  renderer.setClearColor(0, 0);
  button.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, button.clientWidth / button.clientHeight, .1, 20);
  camera.position.set(0, .45, 3.2);
  camera.lookAt(0, .3, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x51575e, 2.7));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-2, 4, 3);
  scene.add(light);
  const ghost = new THREE.Group();
  scene.add(ghost);
  const sheet = new THREE.MeshStandardMaterial({ color: 0xf5f2ec, roughness: .55, metalness: 0, emissive: 0x00ffc6, emissiveIntensity: 0 });
  const ink = new THREE.MeshBasicMaterial({ color: 0x101010 });
  const pink = new THREE.MeshBasicMaterial({ color: 0xff3366 });
  function mesh(geometry, material, parent, x = 0, y = 0, z = 0) {
    const item = new THREE.Mesh(geometry, material);
    item.position.set(x, y, z); parent.add(item); return item;
  }
  const profile = [new THREE.Vector2(0, .8)];
  for (let i = 1; i <= 10; i++) {
    const a = (i / 10) * Math.PI / 2;
    profile.push(new THREE.Vector2(Math.sin(a) * .34, .8 - (1 - Math.cos(a)) * .36));
  }
  profile.push(new THREE.Vector2(.345, .12), new THREE.Vector2(.37, -.14));
  const bodyGeo = new THREE.LatheGeometry(profile, 56);
  const pos = bodyGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0) {
      const ang = Math.atan2(pos.getZ(i), pos.getX(i));
      pos.setY(i, y + Math.sin(ang * 6) * .055);
    }
  }
  bodyGeo.computeVertexNormals();
  mesh(bodyGeo, sheet, ghost);
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(.05, 20, 16), ink, ghost, side * .115, .52, .3);
    eye.scale.set(1, 1.5, .5);
    eyes.push(eye);
  }
  const mouth = mesh(new THREE.SphereGeometry(.03, 16, 12), ink, ghost, 0, .4, .33);
  mouth.scale.set(1, 1.2, .5);
  mouth.visible = false;
  const blush = [];
  for (const side of [-1, 1]) {
    const b = mesh(new THREE.SphereGeometry(.035, 16, 12), pink, ghost, side * .2, .44, .27);
    b.scale.set(1, .6, .4);
    b.visible = false;
    blush.push(b);
  }
  const arms = [];
  for (const side of [-1, 1]) {
    const arm = mesh(new THREE.CapsuleGeometry(.05, .12, 6, 16), sheet, ghost, side * .37, .3, 0);
    arm.rotation.z = side * .5;
    arms.push(arm);
  }
  const laptop = new THREE.Group();
  laptop.position.set(0, .02, .42);
  ghost.add(laptop);
  mesh(new THREE.BoxGeometry(.5, .03, .22), new THREE.MeshStandardMaterial({ color: 0xc4c4c4, roughness: .48, metalness: .18 }), laptop, 0, -.06, .02);
  const lid = mesh(new THREE.BoxGeometry(.46, .27, .025), new THREE.MeshStandardMaterial({ color: 0x444b53, metalness: .55, roughness: .4 }), laptop, 0, .06, .1);
  lid.rotation.x = -.12;
  mesh(new THREE.CircleGeometry(.022, 24), new THREE.MeshBasicMaterial({ color: 0x00ffc6 }), laptop, 0, .06, .115);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let lastFrame = 0;
  renderer.setAnimationLoop(now => {
    if (now - lastFrame < (reduced.matches ? 100 : 33)) return;
    lastFrame = now;
    const t = now / 1000;
    const loved = now < lovedUntil;
    laptop.visible = working;
    mouth.visible = loved;
    blush.forEach(b => { b.visible = loved; });
    sheet.emissive.set(loved ? 0xff3366 : 0x00ffc6);
    sheet.emissiveIntensity = loved ? .22 : working ? .16 : 0;
    const hopPhase = t % 7;
    const hop = !reduced.matches && hopPhase < .6 ? Math.sin((hopPhase / .6) * Math.PI) : 0;
    const spinPhase = t % 13;
    const spin = !reduced.matches && spinPhase < .9 ? (1 - Math.cos((spinPhase / .9) * Math.PI)) / 2 * Math.PI * 2 : 0;
    ghost.position.y = (reduced.matches ? 0 : Math.sin(t * (working ? 5 : 1.6)) * (working ? .008 : .028)) + hop * .14;
    const squish = 1 - hop * .1 + (loved ? Math.sin(t * 10) * .04 : 0);
    ghost.scale.set(1 + hop * .06, squish, 1 + hop * .06);
    ghost.rotation.z = reduced.matches ? 0 : Math.sin(t * 1.1) * .05 + pointer.x * .06;
    ghost.rotation.y = THREE.MathUtils.lerp(ghost.rotation.y, pointer.x * .45, .13) + spin;
    ghost.rotation.x = THREE.MathUtils.lerp(ghost.rotation.x, pointer.y * .16 + (working ? .1 : 0), .13);
    const blink = !reduced.matches && t % 3.7 < .13;
    eyes.forEach(eye => {
      eye.scale.y = blink ? .15 : loved ? .7 : 1.5;
      eye.material = loved ? pink : ink;
      eye.position.x = Math.sign(eye.position.x) * .115 + pointer.x * .02;
    });
    arms.forEach((arm, i) => {
      const side = i === 0 ? -1 : 1;
      arm.rotation.z = side * (.5 + (loved ? Math.sin(t * 12) * .5 : working ? Math.sin(t * 6) * .15 : Math.sin(t * 1.6) * .06));
    });
    renderer.render(scene, camera);
  });
  window.addEventListener('beforeunload', () => { renderer.setAnimationLoop(null); renderer.dispose(); });
}

if (petType === 'ghost') {
  startGhost();
} else try {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(button.clientWidth, button.clientHeight);
  renderer.setClearColor(0, 0);
  button.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, button.clientWidth / button.clientHeight, .1, 20);
  camera.position.set(0, .45, 3.2);
  camera.lookAt(0, .28, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x51575e, 2.7));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-2, 4, 3);
  scene.add(light);
  const robot = new THREE.Group();
  scene.add(robot);
  const silver = new THREE.MeshStandardMaterial({ color: 0xc4c4c4, roughness: .48, metalness: .18 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b1617, roughness: .28, metalness: .2 });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x00ffc6 });
  const pink = new THREE.MeshBasicMaterial({ color: 0xff3366 });
  function mesh(geometry, material, parent, x = 0, y = 0, z = 0) {
    const item = new THREE.Mesh(geometry, material);
    item.position.set(x, y, z); parent.add(item); return item;
  }
  const body = mesh(new THREE.SphereGeometry(.36, 40, 30), silver, robot, 0, -.02, 0);
  body.scale.set(1, .87, 1);
  mesh(new THREE.TorusGeometry(.21, .026, 12, 40), silver, robot, 0, .27, 0).rotation.x = Math.PI / 2;
  const head = new THREE.Group();
  head.position.y = .48;
  robot.add(head);
  mesh(new THREE.SphereGeometry(.27, 48, 32), dark, head);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x00bfa6, transparent: true, opacity: .12, roughness: .2, metalness: .3 });
  mesh(new THREE.SphereGeometry(.279, 40, 28), glass, head);
  const eyes = [];
  for (const side of [-1, 1]) {
    const eye = mesh(new THREE.CapsuleGeometry(.015, .07, 4, 12), cyan, head, side * .078, .012, .259);
    eye.rotation.z = side * -.07;
    eyes.push(eye);
    mesh(new THREE.CylinderGeometry(.04, .04, .05, 24), silver, head, side * .285, 0, 0).rotation.z = Math.PI / 2;
    mesh(new THREE.TorusGeometry(.033, .01, 12, 24), silver, head, side * .31, 0, 0).rotation.y = Math.PI / 2;
    mesh(new THREE.CylinderGeometry(.004, .006, .15, 10), silver, head, side * .31, .09, 0);
    mesh(new THREE.SphereGeometry(.012, 12, 12), pink, head, side * .31, .17, 0);
  }
  for (const side of [-1, 1]) {
    const arm = mesh(new THREE.CapsuleGeometry(.048, .15, 6, 16), silver, robot, side * .36, -.02, .02);
    arm.rotation.z = side * .3;
  }
  const laptop = new THREE.Group();
  laptop.position.set(0, -.14, .43);
  robot.add(laptop);
  mesh(new THREE.BoxGeometry(.57, .035, .25), silver, laptop, 0, -.08, .02);
  const lid = mesh(new THREE.BoxGeometry(.52, .31, .027), new THREE.MeshStandardMaterial({ color: 0x444b53, metalness: .55, roughness: .4 }), laptop, 0, .065, .115);
  lid.rotation.x = -.12;
  mesh(new THREE.CircleGeometry(.025, 24), cyan, laptop, 0, .07, .136);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let lastFrame = 0;
  renderer.setAnimationLoop(now => {
    if (now - lastFrame < (reduced.matches ? 100 : 33)) return;
    lastFrame = now;
    const time = now / 1000;
    laptop.visible = working;
    const loved = now < lovedUntil;
    head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, pointer.x * .5, .13);
    head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, pointer.y * .22 + (working ? .13 : 0), .13);
    robot.position.y = reduced.matches ? 0 : Math.sin(time * (working ? 5 : 1.5)) * (working ? .006 : .014);
    const blink = !reduced.matches && time % 3.5 < .15;
    eyes.forEach(eye => { eye.scale.y = blink ? .1 : loved ? .6 : 1; eye.material = loved ? pink : cyan; });
    renderer.render(scene, camera);
  });
  window.addEventListener('beforeunload', () => { renderer.setAnimationLoop(null); renderer.dispose(); });
} catch {
  document.getElementById('render-error').hidden = false;
}
