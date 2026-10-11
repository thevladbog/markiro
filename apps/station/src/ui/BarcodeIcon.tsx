/** Bundled vector icon, available while the station is offline. */
export function BarcodeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M5 7v18M9 7v18M14 7v18M18 7v18M24 7v18M27 7v18" />
      <path d="M2 10V4h6m16 0h6v6M2 22v6h6m16 0h6v-6" />
    </svg>
  );
}
