import logo from "../assets/markiro-logo-on-dark.svg";

export interface StationBrandProps {
  descriptor: string;
  compact?: boolean;
  className?: string;
}

export function StationBrand({ descriptor, compact = false, className }: StationBrandProps) {
  return (
    <div
      className={["station-brand", compact && "station-brand--compact", className]
        .filter(Boolean)
        .join(" ")}
    >
      <img src={logo} alt="Markiro Station" />
      {compact ? null : <span>{descriptor}</span>}
    </div>
  );
}
