import * as THREE from './vendor/three.module.js';

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
try {
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
