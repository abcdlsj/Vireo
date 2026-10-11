import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, AttachIcon, StopIcon } from "../icons";
import { PendingFile } from "./Attachments";

export function Composer({
  onSend,
  placeholder,
  autoFocus,
  disabled,
  onStop,
  running,
}: {
  onSend: (text: string, files: File[]) => Promise<void> | void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  onStop?: () => void;
  running?: boolean;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if ((!t && files.length === 0) || busy) return;
    setBusy(true);
    try {
      await onSend(t, files);
      setText("");
      setFiles([]);
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  const add = (more: File[]) => more.length && setFiles((prev) => [...prev, ...more]);

  return (
    // Files can also be dropped onto the composer or pasted into it.
    <div
      className={`composer ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        add(Array.from(e.dataTransfer.files));
        ref.current?.focus();
      }}
    >
      {files.length ? (
        <div className="composer-files" data-testid="composer-files">
          {files.map((f, i) => (
            <PendingFile key={`${f.name}${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
          ))}
        </div>
      ) : null}
      <div className="composer-box">
        <button className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="Attach files" title="Attach files">
          <AttachIcon />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder ?? "Message Vireo"}
          autoFocus={autoFocus}
          disabled={disabled}
          data-testid="composer-input"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            add(pasted);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {running && onStop && !text.trim() ? (
          <button className="send stop" onClick={onStop} aria-label="Stop">
            <StopIcon />
          </button>
        ) : (
          <button className="send" onClick={() => void submit()} disabled={busy || (!text.trim() && files.length === 0)} aria-label="Send" data-testid="send">
            <ArrowUpIcon />
          </button>
        )}
      </div>
    </div>
  );
}
