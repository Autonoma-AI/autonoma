interface StageEmptyProps {
  message: string;
}

export function StageEmpty({ message }: StageEmptyProps) {
  return (
    <div className="flex items-center justify-center border border-dashed border-border-dim bg-surface-base px-4 py-6">
      <p className="text-xs text-text-tertiary">{message}</p>
    </div>
  );
}
