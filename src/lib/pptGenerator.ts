import PptxGenJS from "pptxgenjs";

export interface SlideImage {
  dataUrl: string;
  width: number;
  height: number;
}

export async function generatePPT(images: SlideImage[], filename = "slides.pptx") {
  const pptx = new PptxGenJS();

  // 25.4cm x 14.29cm → 인치 변환
  const slideW = 25.4 / 2.54;  // 10 inches
  const slideH = 14.29 / 2.54; // 5.626 inches

  pptx.defineLayout({ name: "CUSTOM", width: slideW, height: slideH });
  pptx.layout = "CUSTOM";

  for (const img of images) {
    const slide = pptx.addSlide();

    slide.addImage({
      data: img.dataUrl,
      x: 0,
      y: 0,
      w: slideW,
      h: slideH,
    });
  }

  await pptx.writeFile({ fileName: filename });
}

export function imageDataToDataUrl(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}
