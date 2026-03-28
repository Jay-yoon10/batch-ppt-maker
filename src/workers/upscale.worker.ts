import * as tf from "@tensorflow/tfjs";
import Img from "../lib/image";
import upscale from "../lib/upscale";

declare const self: DedicatedWorkerGlobalScope;

const BASE_PATH = import.meta.env.BASE_URL;

self.addEventListener("message", async (e: MessageEvent) => {
  const { data } = e;

  const modelUrl = `${BASE_PATH}realcugan/4x-denoise3x-128/model.json`;
  const modelName = "realcugan-4x-denoise3x-128";

  if (!(await tf.setBackend("webgl"))) {
    self.postMessage({ error: "이 브라우저에서 WebGL을 지원하지 않습니다." });
    return;
  }

  let model: tf.GraphModel;
  try {
    model = await tf.loadGraphModel(`indexeddb://${modelName}`);
    self.postMessage({ info: "캐시에서 모델 로드 완료" });
  } catch {
    self.postMessage({ info: "모델 다운로드 중..." });
    const fetchedModel = await tf.loadGraphModel(modelUrl);
    await fetchedModel.save(`indexeddb://${modelName}`);
    model = fetchedModel;
  }

  const totalImages = data.images.length as number;

  for (let idx = 0; idx < totalImages; idx++) {
    const imgData = data.images[idx];
    const input = new Img(
      imgData.width,
      imgData.height,
      new Uint8Array(imgData.data)
    );

    const widthOri = input.width;
    const heightOri = input.height;
    const tileSize = 128;
    const factor = 4;
    const minLap = 12;

    input.padToTileSize(tileSize);
    const withPadding =
      input.width !== widthOri || input.height !== heightOri;

    const output = await enlargeImageWithFixedInput(
      model,
      input,
      factor,
      tileSize,
      minLap,
      idx,
      totalImages
    );

    if (withPadding) {
      output.cropToOriginalSize(widthOri * factor, heightOri * factor);
    }

    self.postMessage(
      {
        imageIndex: idx,
        done: false,
        output: output.data.buffer,
        width: output.width,
        height: output.height,
      },
      [output.data.buffer as ArrayBuffer]
    );
  }

  self.postMessage({ allDone: true });

  async function enlargeImageWithFixedInput(
    model: tf.GraphModel,
    inputImg: Img,
    factor: number,
    inputSize: number,
    minLap: number,
    imageIdx: number,
    totalImages: number
  ): Promise<Img> {
    const width = inputImg.width;
    const height = inputImg.height;
    const output = new Img(width * factor, height * factor);

    let numX = 1;
    for (
      ;
      numX > 1 &&
      (inputSize * numX - width) / (numX - 1) < minLap;
      numX++
    );
    if (width > inputSize) {
      numX = 1;
      for (
        ;
        (inputSize * numX - width) / (numX - 1) < minLap;
        numX++
      );
    }

    let numY = 1;
    if (height > inputSize) {
      numY = 1;
      for (
        ;
        (inputSize * numY - height) / (numY - 1) < minLap;
        numY++
      );
    }

    const locsX = new Array(numX);
    const locsY = new Array(numY);
    const padLeft = new Array(numX);
    const padTop = new Array(numY);
    const padRight = new Array(numX);
    const padBottom = new Array(numY);

    const totalLapX = inputSize * numX - width;
    const totalLapY = inputSize * numY - height;
    const baseLapX = numX > 1 ? Math.floor(totalLapX / (numX - 1)) : 0;
    const baseLapY = numY > 1 ? Math.floor(totalLapY / (numY - 1)) : 0;
    const extraLapX = numX > 1 ? totalLapX - baseLapX * (numX - 1) : 0;
    const extraLapY = numY > 1 ? totalLapY - baseLapY * (numY - 1) : 0;

    locsX[0] = 0;
    for (let i = 1; i < numX; i++) {
      locsX[i] =
        i <= extraLapX
          ? locsX[i - 1] + inputSize - baseLapX - 1
          : locsX[i - 1] + inputSize - baseLapX;
    }
    locsY[0] = 0;
    for (let i = 1; i < numY; i++) {
      locsY[i] =
        i <= extraLapY
          ? locsY[i - 1] + inputSize - baseLapY - 1
          : locsY[i - 1] + inputSize - baseLapY;
    }

    padLeft[0] = 0;
    padTop[0] = 0;
    padRight[numX - 1] = 0;
    padBottom[numY - 1] = 0;

    for (let i = 1; i < numX; i++) {
      padLeft[i] = Math.floor(
        (locsX[i - 1] + inputSize - locsX[i]) / 2
      );
    }
    for (let i = 1; i < numY; i++) {
      padTop[i] = Math.floor(
        (locsY[i - 1] + inputSize - locsY[i]) / 2
      );
    }
    for (let i = 0; i < numX - 1; i++) {
      padRight[i] =
        locsX[i] + inputSize - locsX[i + 1] - padLeft[i + 1];
    }
    for (let i = 0; i < numY - 1; i++) {
      padBottom[i] =
        locsY[i] + inputSize - locsY[i + 1] - padTop[i + 1];
    }

    const total = numX * numY;
    let current = 0;

    for (let i = 0; i < numX; i++) {
      for (let j = 0; j < numY; j++) {
        const x1 = locsX[i];
        const y1 = locsY[j];
        const x2 = locsX[i] + inputSize;
        const y2 = locsY[j] + inputSize;

        const tile = new Img(inputSize, inputSize);
        tile.getImageCrop(0, 0, inputImg, x1, y1, x2, y2);

        const scaled = await upscale(tile, model);

        output.getImageCrop(
          (x1 + padLeft[i]) * factor,
          (y1 + padTop[j]) * factor,
          scaled,
          padLeft[i] * factor,
          padTop[j] * factor,
          scaled.width - padRight[i] * factor,
          scaled.height - padBottom[j] * factor
        );

        current++;
        const tileProgress = (current / total) * 100;
        const overallProgress =
          ((imageIdx + tileProgress / 100) / totalImages) * 100;

        self.postMessage({
          progress: overallProgress,
          info: `이미지 ${imageIdx + 1}/${totalImages}: ${tileProgress.toFixed(1)}%`,
        });
      }
    }

    return output;
  }
});
