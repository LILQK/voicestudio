import { cn } from "@/lib/utils";

type SpeakerAvatarProps = {
  name: string;
  className?: string;
};

const extensionPattern = /\.(pt|pth|bin)$/i;

const buildInitials = (name: string): string => {
  const cleaned = name
    .replace(extensionPattern, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "V";
  }

  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
};

const hashName = (value: string): number => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
};

const buildColor = (name: string): string => {
  const hue = hashName(name) % 360;
  return `hsl(${hue} 58% 46%)`;
};

function SpeakerAvatar({ name, className }: SpeakerAvatarProps) {
  return (
    <span
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full border border-border/80 text-[11px] font-semibold uppercase text-white",
        className,
      )}
      style={{ backgroundColor: buildColor(name) }}
      aria-hidden
    >
      {buildInitials(name)}
    </span>
  );
}

export { SpeakerAvatar };
