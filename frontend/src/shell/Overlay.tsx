import { useLayoutEffect, useRef, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { createPortal } from "react-dom";

interface OverlayProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
  palette?: boolean;
}

export function Overlay({ title, children, onClose, drawer, palette }: OverlayProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Close on backdrop clicks only when the press also started there, so a text selection released over the backdrop keeps the dialog open.
  const pressedBackdrop = useRef(false);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return createPortal(
    <dialog
      ref={ref}
      className={drawer ? "overlay drawer" : palette ? "overlay palette" : "overlay"}
      aria-labelledby="overlay-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={(event) => { pressedBackdrop.current = event.target === event.currentTarget; }}
      onClick={(event) => { if (event.target === event.currentTarget && pressedBackdrop.current) onClose(); pressedBackdrop.current = false; }}
    >
      <motion.div
        className="overlay-content"
        initial={{ opacity: 0, x: !reduced && drawer ? 24 : 0, y: !reduced && !drawer ? 8 : 0 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={reduced ? { duration: 0.12 } : { type: "spring", stiffness: 420, damping: 40 }}
      >
        <div className="overlay-header">
          <h2 id="overlay-title">{title}</h2>
          <button type="button" className="control icon-control" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <XIcon size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </motion.div>
    </dialog>,
    document.body,
  );
}
