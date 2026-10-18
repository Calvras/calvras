import { type CanvasHTMLAttributes, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type AgentAvatarProps = Omit<CanvasHTMLAttributes<HTMLCanvasElement>, "children"> & {
  /** Seed the pattern is generated from — the worker's own role, so the same agent always
   *  looks the same and no image file or stored URL is involved. */
  seed: string;
  size?: number;
  animated?: boolean;
};

const GRID_SIZE = 6;
const PULSE_SPEED = 0.002;
const PULSE_AMPLITUDE = 22;
const BREATHE_SPEED = 0.001;
const BREATHE_AMPLITUDE = 10;
const WAVE_SPEED = 0.0015;
const WAVE_AMPLITUDE = 15;
const WAVE_LENGTH = 3;
const SPARKLE_SPEED = 0.004;
const SPARKLE_THRESHOLD = 0.92;
const SPARKLE_BOOST = 25;
const SCALE_PULSE_SPEED = 0.0008;
const SCALE_PULSE_AMOUNT = 0.03;
const HUE_SPREAD = 45;
const GLOW_RADIUS_RATIO = 0.25;

const hashSeed = (str: string): number => {
  let hash = 0;
  for (const char of str) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
};

const createRng = (seed: number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

type HSL = [hue: number, saturation: number, lightness: number];

const generatePalette = (hash: number): [HSL, HSL, HSL] => {
  const rng = createRng(hash);
  const baseHue = rng() * 360;
  const sat = 75 + rng() * 20;
  return [
    [baseHue, sat, 55 + rng() * 10],
    [(baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2) % 360, sat - 5 + rng() * 10, 40 + rng() * 15],
    [(baseHue - HUE_SPREAD + rng() * HUE_SPREAD * 2) % 360, sat - 10 + rng() * 15, 60 + rng() * 15],
  ];
};

type Cell = { colorIndex: number; phase: number; brightness: number; sparklePhase: number };

const generateGrid = (hash: number): Cell[][] => {
  const rng = createRng(hash + 1);
  const grid: Cell[][] = [];
  for (let y = 0; y < GRID_SIZE; y++) {
    const row: Cell[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      row.push({ brightness: 0.3 + rng() * 0.7, colorIndex: Math.floor(rng() * 3), phase: rng() * Math.PI * 2, sparklePhase: rng() * Math.PI * 2 });
    }
    grid.push(row);
  }
  return grid;
};

/** The app's own Motion setting is the same switch CSS animation honours, so an avatar that
 *  keeps pulsing after the user asked for reduced motion would be ignoring them. */
const isStill = (media: MediaQueryList) => media.matches || document.documentElement.dataset["reduceMotion"] === "true";

export default function AgentAvatar({ seed, size = 64, animated = true, className, ...props }: AgentAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const hash = hashSeed(seed);
    const palette = generatePalette(hash);
    const grid = generateGrid(hash);
    const cellSize = size / GRID_SIZE;
    const half = size / 2;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let shouldAnimate = animated && !isStill(motionQuery);

    const draw = (time: number) => {
      ctx.clearRect(0, 0, size, size);
      const scale = shouldAnimate ? 1 + Math.sin(time * SCALE_PULSE_SPEED) * SCALE_PULSE_AMOUNT : 1;

      ctx.save();
      ctx.translate(half, half);
      ctx.scale(scale, scale);
      ctx.translate(-half, -half);
      ctx.beginPath();
      ctx.arc(half, half, half, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#08080f";
      ctx.fillRect(0, 0, size, size);

      const breatheOffset = shouldAnimate ? Math.sin(time * BREATHE_SPEED) * BREATHE_AMPLITUDE : 0;
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const cell = grid[y]?.[x];
          if (!cell) continue;
          const swatch = palette[cell.colorIndex];
          if (!swatch) continue;
          const [h, s, l] = swatch;
          const pulse = shouldAnimate ? Math.sin(time * PULSE_SPEED + cell.phase) * PULSE_AMPLITUDE : 0;
          const wave = shouldAnimate ? Math.sin(time * WAVE_SPEED + (x + y) / WAVE_LENGTH) * WAVE_AMPLITUDE : 0;
          const sparkleVal = shouldAnimate ? Math.sin(time * SPARKLE_SPEED + cell.sparklePhase) : 0;
          const sparkle = sparkleVal > SPARKLE_THRESHOLD ? ((sparkleVal - SPARKLE_THRESHOLD) / (1 - SPARKLE_THRESHOLD)) * SPARKLE_BOOST : 0;
          const finalLight = Math.min(90, Math.max(20, (l + pulse + breatheOffset + wave + sparkle) * cell.brightness));
          const finalSat = Math.min(100, s + 5);
          ctx.shadowColor = `hsl(${h}, ${finalSat}%, ${finalLight}%)`;
          ctx.shadowBlur = cellSize * 0.45;
          ctx.fillStyle = `hsl(${h}, ${finalSat}%, ${finalLight}%)`;
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
      }
      ctx.shadowBlur = 0;
      ctx.restore();

      const ring = palette[0];
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.shadowColor = `hsla(${ring[0]}, ${ring[1]}%, ${ring[2]}%, 0.6)`;
      ctx.shadowBlur = size * GLOW_RADIUS_RATIO;
      ctx.beginPath();
      ctx.arc(half, half, half - 1, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${ring[0]}, ${ring[1]}%, ${ring[2]}%, 0.15)`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      if (shouldAnimate) rafRef.current = requestAnimationFrame(draw);
    };

    const handleMotionChange = () => {
      cancelAnimationFrame(rafRef.current);
      shouldAnimate = animated && !isStill(motionQuery);
      if (shouldAnimate) rafRef.current = requestAnimationFrame(draw);
      else draw(0);
    };

    motionQuery.addEventListener("change", handleMotionChange);
    window.addEventListener("calvras:preferences", handleMotionChange);
    if (shouldAnimate) rafRef.current = requestAnimationFrame(draw);
    else draw(0);

    return () => {
      cancelAnimationFrame(rafRef.current);
      motionQuery.removeEventListener("change", handleMotionChange);
      window.removeEventListener("calvras:preferences", handleMotionChange);
    };
  }, [seed, size, animated]);

  return <canvas ref={canvasRef} role="img" aria-label={`Avatar for ${seed}`} className={cn("rounded-full shrink-0", className)} style={{ height: size, width: size }} {...props} />;
}
