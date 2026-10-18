import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FileDropZone, Input, Modal, toast } from "@markiro/ui";

import { useUserAvatarPhoto, useStoreAvatar } from "./avatar-photo.js";
import { cropRect, initialCrop, type CropState } from "./avatar-crop.js";
import { encodeAvatar } from "./avatar-encode.js";
import { loadAvatarPicture, AvatarPictureError, type AvatarPicture } from "./avatar-picture.js";
import {
  AVATAR_ACCEPT,
  avatarProblemOfError,
  canReplaceAvatar,
  checkAvatarFile,
  type AvatarProblem,
} from "./avatar-rules.js";
import { CropEditor } from "./CropEditor.js";
import { OfficeIcon } from "../OfficeIcon.js";
import { officeKeys, useOfficeMutation } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { UserAvatar } from "../UserAvatar.js";
import { useQueryClient } from "@tanstack/react-query";

export interface ProfileDialogProps {
  open: boolean;
  onClose: () => void;
}

type Stage =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "crop"; picture: AvatarPicture; crop: CropState }
  | { kind: "uploading" };

/**
 * «Профиль» (plan АВА, DESIGN §10): who is signed in and their photo. The photo is a circle made of
 * a square the person crops here; the cropped square is drawn on a canvas and only those bytes go to
 * the host, so the original file's metadata never leaves the PC. Only the owner changes their photo.
 * The name is the administrator's to change («Пользователи»), the login never changes.
 */
export function ProfileDialog({ open, onClose }: ProfileDialogProps) {
  const { t } = useTranslation();
  const session = useOfficeSession();
  const queryClient = useQueryClient();
  const user = session.user;
  const photo = useUserAvatarPhoto(open ? user.id : null, user.avatarVersion, true);
  const store = useStoreAvatar();
  const put = useOfficeMutation((api, token, dataBase64: string) =>
    api.putUserAvatar(token, user.id, { dataBase64 }),
  );
  const clear = useOfficeMutation((api, token, _: null) => api.deleteUserAvatar(token, user.id));
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [problem, setProblem] = useState<AvatarProblem | null>(null);
  const [saveProblem, setSaveProblem] = useState<AvatarProblem | null>(null);
  // The latest pick wins over a slower earlier read.
  const pick = useRef(0);
  const picture = useRef<AvatarPicture | null>(null);
  picture.current = stage.kind === "crop" ? stage.picture : null;

  const busy = stage.kind === "uploading" || stage.kind === "reading" || clear.isPending;
  const mine = canReplaceAvatar(user, user.id);
  const hasPhoto = photo.status === "photo";
  const unsupported = photo.status === "unsupported";

  // A picture is released when it is replaced, and when the dialog closes or unmounts.
  useEffect(() => () => picture.current?.release(), []);
  useEffect(() => {
    if (!open) {
      pick.current += 1;
      setStage((was) => {
        if (was.kind === "crop") was.picture.release();
        return { kind: "idle" };
      });
      setProblem(null);
      setSaveProblem(null);
    }
  }, [open]);

  const release = () => {
    if (stage.kind === "crop") stage.picture.release();
  };

  const choose = async (file: File) => {
    const mineRead = ++pick.current;
    setProblem(null);
    setSaveProblem(null);
    const wrong = checkAvatarFile(file);
    if (wrong !== null) {
      release();
      setStage({ kind: "idle" });
      setProblem(wrong);
      return;
    }
    release();
    setStage({ kind: "reading" });
    try {
      const loaded = await loadAvatarPicture(file);
      if (mineRead !== pick.current) {
        loaded.release();
        return;
      }
      setStage({
        kind: "crop",
        picture: loaded,
        crop: initialCrop(loaded.width, loaded.height),
      });
    } catch (error) {
      if (mineRead !== pick.current) return;
      setStage({ kind: "idle" });
      setProblem(error instanceof AvatarPictureError ? error.problem : "unreadable");
    }
  };

  const apply = async () => {
    if (stage.kind !== "crop") return;
    const { picture: loaded, crop } = stage;
    setSaveProblem(null);
    setStage({ kind: "uploading" });
    try {
      const encoded = await encodeAvatar(loaded.image, cropRect(loaded.width, loaded.height, crop));
      const state = await put.mutateAsync(encoded.dataBase64);
      loaded.release();
      store(user.id, state);
      setStage({ kind: "idle" });
      toast("ok", t("office.profile.photo.saved"), undefined, t("office.common.close"));
      // The header and the menu read `avatarVersion` of the session's user.
      void session.refreshUser().catch(() => undefined);
    } catch (error) {
      // The picture stays: the person can crop again or choose another file.
      setStage({ kind: "crop", picture: loaded, crop });
      setSaveProblem(avatarProblemOfError(error));
    }
  };

  const remove = async () => {
    if (busy) return;
    setProblem(null);
    setSaveProblem(null);
    try {
      const state = await clear.mutateAsync(null);
      queryClient.setQueryData(officeKeys.userAvatar(user.id, 0), state);
      store(user.id, state);
      toast("ok", t("office.profile.photo.removed"), undefined, t("office.common.close"));
      void session.refreshUser().catch(() => undefined);
    } catch (error) {
      setSaveProblem(avatarProblemOfError(error));
    }
  };

  const shownProblem = problem ?? saveProblem;
  const roleLabel = t(`office.users.roles.${user.role}`);

  return (
    <Modal
      open={open}
      title={t("office.profile.title")}
      onClose={() => {
        if (stage.kind !== "uploading") onClose();
      }}
      closeLabel={t("office.common.close")}
      width={680}
      className="profile-dialog"
      footer={
        <Button variant="secondary" onClick={onClose} disabled={stage.kind === "uploading"}>
          {t("office.common.close")}
        </Button>
      }
    >
      <div className="profile">
        <div className="profile__identity">
          <UserAvatar
            name={user.name}
            size={96}
            userId={user.id}
            avatarVersion={user.avatarVersion}
            label={t("office.profile.photo.label", { name: user.name })}
          />
          <div className="profile__who">
            <span className="profile__name">{user.name}</span>
            <span className="profile__meta">{`${user.login} · ${roleLabel}`}</span>
          </div>
        </div>

        <section className="profile__section" aria-labelledby="profile-photo-title">
          <h3 id="profile-photo-title" className="profile__section-title">
            {t("office.profile.photoTitle")}
          </h3>
          {unsupported ? (
            <Alert tone="info">{t("office.profile.photo.unsupportedHost")}</Alert>
          ) : (
            <>
              {stage.kind === "crop" || stage.kind === "uploading" ? (
                stage.kind === "crop" ? (
                  <CropEditor
                    src={stage.picture.src}
                    width={stage.picture.width}
                    height={stage.picture.height}
                    crop={stage.crop}
                    disabled={false}
                    onCrop={(crop) => setStage({ ...stage, crop })}
                    onApply={() => void apply()}
                    onOther={() => {
                      // Back to the zone: it opens the picker, takes a dropped file, and says what it takes.
                      pick.current += 1;
                      release();
                      setStage({ kind: "idle" });
                    }}
                  />
                ) : (
                  <div className="profile__uploading" role="status">
                    <span
                      className="profile__progress"
                      role="progressbar"
                      aria-label={t("office.profile.photo.uploading")}
                    />
                    <span>{t("office.profile.photo.uploading")}</span>
                  </div>
                )
              ) : (
                <div
                  className={
                    shownProblem === null ? "profile__zone" : "profile__zone profile__zone--error"
                  }
                >
                  <FileDropZone
                    compact
                    label={t("office.profile.photo.drop")}
                    accept={AVATAR_ACCEPT}
                    busy={stage.kind === "reading"}
                    disabled={!mine || clear.isPending}
                    onFile={(file) => void choose(file)}
                    onRejected={() => {
                      pick.current += 1;
                      setProblem("unsupportedType");
                    }}
                  />
                  <Button
                    variant="secondary"
                    icon={<OfficeIcon name="trash" size={20} />}
                    disabled={!hasPhoto || busy}
                    onClick={() => void remove()}
                  >
                    {t("office.profile.photo.remove")}
                  </Button>
                </div>
              )}
              {shownProblem !== null && (
                <Alert tone="error" role="alert">
                  <strong>
                    {t(
                      saveProblem !== null && problem === null
                        ? "office.profile.photo.saveErrorTitle"
                        : "office.profile.photo.errorTitle",
                    )}
                  </strong>{" "}
                  {t(`office.profile.photo.problems.${shownProblem}`)}
                </Alert>
              )}
              {photo.status === "none" && photo.failed === true && (
                <p className="office-note">{t("office.profile.photo.loadFailed")}</p>
              )}
              <p className="profile__hint">{t("office.profile.photo.limits")}</p>
            </>
          )}
        </section>

        <section className="profile__section" aria-labelledby="profile-data-title">
          <h3 id="profile-data-title" className="profile__section-title">
            {t("office.profile.dataTitle")}
          </h3>
          <div className="profile__fields">
            <Input
              label={t("office.profile.fields.name")}
              value={user.name}
              readOnly
              hint={t("office.profile.nameHint")}
            />
            <Input
              label={t("office.profile.fields.login")}
              value={user.login}
              readOnly
              disabled
              mono
              hint={t("office.profile.loginHint")}
            />
          </div>
        </section>
      </div>
    </Modal>
  );
}
