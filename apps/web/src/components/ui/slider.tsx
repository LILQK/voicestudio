import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@/lib/utils";

type SliderProps = {
  className?: string;
  value?: number[];
  defaultValue?: number[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onValueChange?: (value: number[]) => void;
  onValueCommitted?: (value: number[]) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  "aria-label"?: string;
};

function Slider({
  className,
  value,
  defaultValue,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  onValueChange,
  onValueCommitted,
  onScrubStart,
  onScrubEnd,
  ...props
}: SliderProps) {
  const isControlled = value !== undefined;
  const safeValue = value?.[0] ?? min;
  const safeDefault = defaultValue?.[0] ?? min;

  return (
    <SliderPrimitive.Root
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={isControlled ? safeValue : undefined}
      defaultValue={isControlled ? undefined : safeDefault}
      onValueChange={(next) => onValueChange?.([next])}
      onValueCommitted={(next) => onValueCommitted?.([next])}
      onPointerDownCapture={() => onScrubStart?.()}
      onPointerUpCapture={() => onScrubEnd?.()}
      onPointerCancelCapture={() => onScrubEnd?.()}
      className={cn(
        "group relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Control className="relative h-5 w-full">
        <SliderPrimitive.Track className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-muted">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-foreground" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block size-4 rounded-full border border-border bg-background shadow-sm transition-colors outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50" />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
