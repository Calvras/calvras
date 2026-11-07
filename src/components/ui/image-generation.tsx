export function ImageGeneration({
  prompt = "a calm mountain lake at dawn",
  resolution = "1024 × 1024",
}: {
  prompt?: string;
  resolution?: string;
}) {
  return (
    <div className="igWrap">
      <div className="igCanvas" role="img" aria-label="Generating image">
        <span className="igDots" aria-hidden />
        <span className="igGlow" aria-hidden />
        <span className="igRes">{resolution}</span>
      </div>
      <div className="igMeta">
        <span className="igLabel">Generating image</span>
        <span className="igPrompt">“{prompt}”</span>
      </div>
    </div>
  );
}

export default ImageGeneration;
