import {
  BoldItalicUnderlineToggles,
  CreateLink,
  headingsPlugin,
  InsertTable,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  MDXEditor,
  tablePlugin,
  toolbarPlugin,
  UndoRedo,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

export interface OfferTermsEditorProps {
  value: string | null;
  onChange: (markdown: string) => void;
  label: string;
  error?: string;
}

export function OfferTermsEditor({ value, onChange, label, error }: OfferTermsEditorProps) {
  const errorId = "offer-terms-error";
  const helpId = "offer-terms-help";

  return (
    <section className="offer-terms-editor" aria-labelledby="offer-terms-heading">
      <div className="offer-terms-editor__heading">
        <h2 id="offer-terms-heading">{label}</h2>
        <p id={helpId}>
          Заголовки, списки, ссылки и таблицы. Изображения и HTML не поддерживаются.
        </p>
      </div>
      <MDXEditor
        markdown={value ?? ""}
        onChange={onChange}
        plugins={[
          headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
          listsPlugin(),
          linkPlugin(),
          tablePlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BoldItalicUnderlineToggles />
                <ListsToggle />
                <CreateLink />
                <InsertTable />
              </>
            ),
          }),
        ]}
        aria-describedby={error ? `${helpId} ${errorId}` : helpId}
      />
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
