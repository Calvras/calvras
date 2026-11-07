import { ImageGeneration } from "@/components/ui/image-generation";

export default function Default() {
  return (
    <div className="flex min-h-[320px] w-full items-center justify-center p-10">
      <ImageGeneration
        prompt="a calm mountain lake at dawn"
        resolution="1024 × 1024"
      />
    </div>
  );
}
