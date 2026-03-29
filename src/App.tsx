import { useState, useCallback, useRef } from "react";
import JSZip from "jszip";
import {
  generatePPT,
  imageDataToDataUrl,
  type SlideImage,
} from "./lib/pptGenerator";
import "./App.css";

interface UploadedImage {
  file: File;
  preview: string;
  width: number;
  height: number;
}

type ProcessingState =
  | { status: "idle" }
  | { status: "upscaling"; progress: number; info: string }
  | { status: "generating-ppt"; info: string }
  | { status: "downloading"; info: string }
  | { status: "done"; message: string };

function App() {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [processing, setProcessing] = useState<ProcessingState>({
    status: "idle",
  });
  const [upscaledResults, setUpscaledResults] = useState<SlideImage[] | null>(
    null
  );
  const workerRef = useRef<Worker | null>(null);

  const loadImage = (file: File): Promise<UploadedImage> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          resolve({
            file,
            preview: reader.result as string,
            width: img.naturalWidth,
            height: img.naturalHeight,
          });
        };
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) =>
      f.type.startsWith("image/")
    );
    const loaded = await Promise.all(imageFiles.map(loadImage));
    setImages((prev) => [...prev, ...loaded]);
    setUpscaledResults(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
    setUpscaledResults(null);
  };

  const clearAll = () => {
    setImages([]);
    setUpscaledResults(null);
  };

  const getImagePixelData = (
    img: UploadedImage
  ): Promise<{ data: ArrayBuffer; width: number; height: number }> => {
    return new Promise((resolve) => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      const image = new Image();
      image.onload = () => {
        ctx.drawImage(image, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const buffer = imageData.data.buffer.slice(0);
        resolve({ data: buffer, width: img.width, height: img.height });
      };
      image.src = img.preview;
    });
  };

  const runUpscale = (): Promise<SlideImage[]> => {
    return new Promise(async (resolve, reject) => {
      const pixelDataList = await Promise.all(images.map(getImagePixelData));

      const worker = new Worker(
        new URL("./workers/upscale.worker.ts", import.meta.url),
        { type: "module" }
      );
      workerRef.current = worker;

      const results: SlideImage[] = new Array(images.length);

      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message || "Worker error"));
      };

      worker.onmessage = (e) => {
        const msg = e.data;

        if (msg.error) {
          worker.terminate();
          reject(new Error(msg.error));
          return;
        }

        if (msg.progress !== undefined) {
          setProcessing({
            status: "upscaling",
            progress: msg.progress,
            info: msg.info || "",
          });
        }

        if (msg.imageIndex !== undefined && msg.output) {
          const dataUrl = imageDataToDataUrl(
            new Uint8Array(msg.output),
            msg.width,
            msg.height
          );
          results[msg.imageIndex] = {
            dataUrl,
            width: msg.width,
            height: msg.height,
          };
        }

        if (msg.allDone) {
          worker.terminate();
          resolve(results);
        }
      };

      worker.postMessage(
        {
          images: pixelDataList.map((p) => ({
            data: p.data,
            width: p.width,
            height: p.height,
          })),
        },
        pixelDataList.map((p) => p.data)
      );
    });
  };

  const handleUpscaleOnly = async () => {
    if (images.length === 0) return;
    setProcessing({ status: "upscaling", progress: 0, info: "준비 중..." });
    try {
      const results = await runUpscale();
      setUpscaledResults(results);
      setProcessing({ status: "done", message: "업스케일 완료! 아래에서 내보내기 형식을 선택하세요." });
    } catch (err) {
      alert(err instanceof Error ? err.message : "업스케일 실패");
      setProcessing({ status: "idle" });
    }
  };

  const handleExportPPT = async (slideImages: SlideImage[]) => {
    setProcessing({ status: "generating-ppt", info: "PPT 생성 중..." });
    await generatePPT(slideImages);
    setProcessing({ status: "done", message: "PPT 다운로드 완료!" });
    setTimeout(() => setProcessing({ status: "idle" }), 2000);
  };

  const handleExportImages = async (slideImages: SlideImage[]) => {
    setProcessing({ status: "downloading", info: "이미지 준비 중..." });

    if (slideImages.length === 1) {
      const link = document.createElement("a");
      link.href = slideImages[0].dataUrl;
      const originalName = images[0]?.file.name.replace(/\.[^.]+$/, "") ?? "image";
      link.download = `${originalName}_upscaled.png`;
      link.click();
    } else {
      const zip = new JSZip();
      for (let i = 0; i < slideImages.length; i++) {
        const base64 = slideImages[i].dataUrl.split(",")[1];
        const originalName = images[i]?.file.name.replace(/\.[^.]+$/, "") ?? `image_${i + 1}`;
        zip.file(`${originalName}_upscaled.png`, base64, { base64: true });
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "upscaled_images.zip";
      link.click();
      URL.revokeObjectURL(link.href);
    }

    setProcessing({ status: "done", message: "이미지 다운로드 완료!" });
    setTimeout(() => setProcessing({ status: "idle" }), 2000);
  };

  const handleDirectPPT = async () => {
    if (images.length === 0) return;
    const slideImages: SlideImage[] = images.map((img) => ({
      dataUrl: img.preview,
      width: img.width,
      height: img.height,
    }));
    await handleExportPPT(slideImages);
  };

  const isProcessing =
    processing.status !== "idle" &&
    processing.status !== "done";

  const showExportOptions = upscaledResults !== null && !isProcessing;

  return (
    <div className="app">
      <h1>Batch PPT Maker</h1>
      <p className="subtitle">
        이미지를 드래그 앤 드롭하여 PPT를 만들어보세요
      </p>

      <div
        className={`dropzone ${images.length > 0 ? "has-images" : ""}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => {
          if (!isProcessing) {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.accept = "image/*";
            input.onchange = () => {
              if (input.files) handleFiles(input.files);
            };
            input.click();
          }
        }}
      >
        {images.length === 0 ? (
          <div className="dropzone-empty">
            <div className="dropzone-icon">+</div>
            <p>여기에 이미지를 놓거나 클릭하여 선택하세요</p>
          </div>
        ) : (
          <div className="image-grid">
            {images.map((img, i) => (
              <div key={i} className="image-thumb">
                <img src={img.preview} alt={`Preview ${i + 1}`} />
                <button
                  className="remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeImage(i);
                  }}
                  disabled={isProcessing}
                >
                  x
                </button>
                <span className="image-info">
                  {img.width}x{img.height}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {images.length > 0 && (
        <div className="controls">
          <span className="image-count">{images.length}개 이미지</span>
          <button
            className="btn btn-clear"
            onClick={clearAll}
            disabled={isProcessing}
          >
            전체 삭제
          </button>
        </div>
      )}

      {processing.status === "upscaling" && (
        <div className="progress-section">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${processing.progress}%` }}
            />
          </div>
          <p className="progress-info">{processing.info}</p>
        </div>
      )}

      {(processing.status === "generating-ppt" || processing.status === "downloading") && (
        <div className="progress-section">
          <p className="progress-info">{processing.info}</p>
        </div>
      )}

      {processing.status === "done" && (
        <div className="progress-section">
          <p className="progress-info done">{processing.message}</p>
        </div>
      )}

      {showExportOptions && (
        <div className="export-section">
          <p className="export-label">{upscaledResults.length}개 이미지 업스케일 완료 — 내보내기:</p>
          <div className="export-actions">
            <button
              className="btn btn-primary"
              onClick={() => handleExportPPT(upscaledResults)}
            >
              PPT 다운로드
            </button>
            <button
              className="btn btn-accent"
              onClick={() => handleExportImages(upscaledResults)}
            >
              이미지 다운로드
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        <button
          className="btn btn-primary"
          onClick={handleUpscaleOnly}
          disabled={images.length === 0 || isProcessing}
        >
          업스케일 (4x)
        </button>
        <button
          className="btn btn-secondary"
          onClick={handleDirectPPT}
          disabled={images.length === 0 || isProcessing}
        >
          바로 PPT 생성
        </button>
      </div>
    </div>
  );
}

export default App;
