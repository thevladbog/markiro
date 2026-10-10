import { createContext, useContext, type ReactNode } from "react";

import { printInFrame } from "./print-form.js";

/** Prints a form's HTML; the office's own window by default, a test's mock otherwise. */
export type PrintForm = (html: string) => void;

/** The webview's hidden frame (`printInFrame`). */
export const FRAME_PRINT_FORM: PrintForm = (html) => printInFrame(html);

const FormPrinterContext = createContext<PrintForm>(FRAME_PRINT_FORM);

/** Gives the office below another way to print its forms (tests). */
export function FormPrinterProvider({
  value,
  children,
}: {
  value: PrintForm;
  children: ReactNode;
}) {
  return <FormPrinterContext value={value}>{children}</FormPrinterContext>;
}

/** How the office prints a form. */
export function usePrintForm(): PrintForm {
  return useContext(FormPrinterContext);
}
