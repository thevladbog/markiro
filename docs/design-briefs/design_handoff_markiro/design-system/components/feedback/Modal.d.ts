/** Модальное окно (офис). В цехе маленьких модалок нет — используйте FullScreenDialog. */
export interface ModalProps {
  open: boolean;
  title?: string;
  children?: React.ReactNode;
  /** Кнопки внизу справа */
  footer?: React.ReactNode;
  onClose?: () => void;
  width?: number;
  style?: React.CSSProperties;
}
/** Полноэкранный диалог цеха — вместо модалок на touch. */
export interface FullScreenDialogProps {
  open: boolean;
  title?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: () => void;
}
