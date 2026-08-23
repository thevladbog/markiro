import { useEffect, useRef } from "react";

/**
 * Camera SSCC scanner, lazy-loaded (default export) so neither camera glue
 * nor the zxing fallback reaches the main bundle. Native BarcodeDetector
 * (Android Chrome) is preferred; iOS Safari has no BarcodeDetector, so
 * @zxing/browser decodes frames from the same <video> element there.
 * Detection is throttled by requestAnimationFrame-loop (native) or zxing's
 * own callback; the FIRST successful decode wins -- parent validates via
 * parseScannedSscc and may show an error without closing the camera.
 */
export default function SsccScanner({
  onDetected,
  onError,
}: {
  onDetected: (raw: string) => void;
  onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onDetectedRef = useRef(onDetected);
  const onErrorRef = useRef(onError);
  onDetectedRef.current = onDetected;
  onErrorRef.current = onError;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let stopZxing: (() => void) | null = null;
    let rafId = 0;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video!.srcObject = stream;
        await video!.play();

        const DetectorCtor = (
          window as unknown as {
            BarcodeDetector?: new (options: { formats: string[] }) => {
              detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
            };
          }
        ).BarcodeDetector;

        if (DetectorCtor) {
          const detector = new DetectorCtor({ formats: ["code_128"] });
          const tick = async () => {
            if (stopped) return;
            try {
              const found = await detector.detect(video!);
              if (found.length > 0) {
                onDetectedRef.current(found[0]!.rawValue);
                return;
              }
            } catch {
              // одиночный сбой кадра -- продолжаем
            }
            rafId = requestAnimationFrame(() => void tick());
          };
          rafId = requestAnimationFrame(() => void tick());
        } else {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          if (stopped) return;
          const reader = new BrowserMultiFormatReader();
          const controls = await reader.decodeFromVideoElement(video!, (result) => {
            if (result && !stopped) onDetectedRef.current(result.getText());
          });
          stopZxing = () => controls.stop();
        }
      } catch {
        if (!stopped) onErrorRef.current();
      }
    }

    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
      stopZxing?.();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return <video ref={videoRef} className="mk-sell-scanner__video" muted playsInline />;
}
