"use client";

import { useCallback, useRef, useState } from "react";
import { FileUp } from "lucide-react";

interface ResumeUploadZoneProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export function ResumeUploadZone({ onFileSelected, disabled }: ResumeUploadZoneProps): React.JSX.Element {
  const [isDragOver, setIsDragOver] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validate = useCallback((file: File): string | null => {
    if (file.type !== "application/pdf") return "Only PDF files are supported";
    if (file.size > 5 * 1024 * 1024) return "File must be under 5MB";
    return null;
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      const error = validate(file);
      if (error) {
        setValidationError(error);
        return;
      }
      setValidationError(null);
      onFileSelected(file);
    },
    [onFileSelected, validate]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;

      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [disabled, handleFile]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setIsDragOver(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleClick = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset so same file can be selected again
      e.target.value = "";
    },
    [handleFile]
  );

  return (
    <div className="flex flex-col items-center gap-4">
      <button
        type="button"
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        disabled={disabled}
        className={`
          flex w-full max-w-md flex-col items-center gap-4 rounded-xl border-2 border-dashed
          px-8 py-12 transition-all duration-200
          ${isDragOver ? "border-accent bg-accent/5 scale-[1.02]" : "border-border/60 hover:border-[var(--text-tertiary)]"}
          ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}
        `}
      >
        <div className={`rounded-full p-4 ${isDragOver ? "bg-accent/10" : "bg-[var(--bg-tertiary)]"}`}>
          <FileUp className={`h-8 w-8 ${isDragOver ? "text-accent" : "text-[var(--text-tertiary)]"}`} />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            Drop your resume here or click to browse
          </p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">PDF only, up to 5MB</p>
        </div>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        onChange={handleChange}
        className="hidden"
        aria-label="Upload resume PDF"
      />

      {validationError ? (
        <p className="text-sm text-red-400">{validationError}</p>
      ) : null}
    </div>
  );
}
