import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AvatarPictureModule from "../src/office/avatar/avatar-picture.js";
import { HostError } from "../src/host/client.js";
import type { OfficeUser, UserAvatarState } from "../src/host/protocol.js";
import { ProfileDialog } from "../src/office/avatar/ProfileDialog.js";
import { createOfficeQueryClient } from "../src/office/office-query.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { UserAvatar } from "../src/office/UserAvatar.js";
import { fakeHostApi, fakeOfficeSession } from "./support/office.js";

const loaded = vi.hoisted(() => ({ fail: null as null | string }));

vi.mock("../src/office/avatar/avatar-picture.js", async (original) => {
  const real = await original<typeof AvatarPictureModule>();
  return {
    ...real,
    loadAvatarPicture: vi.fn(async () => {
      if (loaded.fail !== null) throw new real.AvatarPictureError(loaded.fail as never);
      return {
        image: {} as HTMLImageElement,
        width: 800,
        height: 600,
        src: "blob:picked",
        release: vi.fn(),
      };
    }),
  };
});
vi.mock("../src/office/avatar/avatar-encode.js", () => ({
  AvatarEncodeError: class extends Error {},
  encodeAvatar: vi.fn(async () => ({ dataBase64: "QUJD", mediaType: "image/webp", side: 256 })),
}));

const OWNER: OfficeUser = {
  id: "11111111-1111-4111-8111-111111111111",
  login: "ivan",
  name: "Иван Петров",
  role: "admin",
  avatarVersion: null,
};

const photoState = (version: number): UserAvatarState => ({
  avatar: {
    width: 256,
    height: 256,
    dataBase64: "QUJD",
    mediaType: "image/webp",
    checksum: "a".repeat(64),
    version,
    updatedAt: "2026-10-17T10:00:00Z",
  },
});

const notFound = () =>
  new HostError({ kind: "api", code: "not_found", message: "no route", status: 404 });

function mount(user: OfficeUser, api = fakeHostApi()) {
  const session = fakeOfficeSession({ user, api });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={createOfficeQueryClient()}>
      <OfficeSessionProvider value={session}>
        <ProfileDialog open onClose={onClose} />
      </OfficeSessionProvider>
    </QueryClientProvider>,
  );
  return { session, api, onClose };
}

function pick(file: File) {
  fireEvent.change(document.querySelector("input[type=file]") as HTMLInputElement, {
    target: { files: [file] },
  });
}

const png = (size = 10) => new File([new Uint8Array(size)], "me.png", { type: "image/png" });

beforeEach(() => {
  loaded.fail = null;
});

describe("ProfileDialog", () => {
  it("shows the person, initials, an upload zone and a disabled «Убрать фото» without a photo", async () => {
    const { api } = mount(OWNER);
    const dialog = await screen.findByRole("dialog", { name: "Профиль" });
    expect(within(dialog).getByText("Иван Петров", { selector: ".profile__name" })).toBeTruthy();
    expect(within(dialog).getByText("ivan · Администратор")).toBeTruthy();
    expect(within(dialog).getByRole("img", { name: "Фото: Иван Петров" }).textContent).toBe("ИП");
    expect(
      (within(dialog).getByRole("button", { name: "Убрать фото" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(dialog).getByText(/JPEG, PNG или WebP, до 2 МБ, от 128×128 px/)).toBeTruthy();
    await waitFor(() =>
      expect(api.getUserAvatar).toHaveBeenCalledWith(expect.any(String), OWNER.id),
    );
  });

  it("shows the saved photo and removes it, telling the shell to re-read the user", async () => {
    const api = fakeHostApi({
      getUserAvatar: vi.fn(async () => photoState(3)),
      deleteUserAvatar: vi.fn(async () => ({ avatar: null })),
    });
    const { session } = mount({ ...OWNER, avatarVersion: 3 }, api);
    const dialog = await screen.findByRole("dialog");
    const remove = within(dialog).getByRole("button", { name: "Убрать фото" });
    await waitFor(() => expect((remove as HTMLButtonElement).disabled).toBe(false));
    expect(dialog.querySelector("img.user-avatar--photo")?.getAttribute("src")).toBe(
      "data:image/webp;base64,QUJD",
    );
    fireEvent.click(remove);
    await waitFor(() =>
      expect(api.deleteUserAvatar).toHaveBeenCalledWith(expect.any(String), OWNER.id),
    );
    await waitFor(() => expect(session.refreshUser).toHaveBeenCalled());
  });

  it("hides the upload on a host without the feature (the read is not_found) and does not crash", async () => {
    const api = fakeHostApi({
      getUserAvatar: vi.fn(async () => {
        throw notFound();
      }),
    });
    mount(OWNER, api);
    expect(
      await screen.findByText(/Хост этого офиса ещё не умеет хранить фото профиля/),
    ).toBeTruthy();
    expect(screen.queryByText("Перетащите фото сюда или выберите файл")).toBeNull();
    expect(screen.queryByRole("button", { name: "Убрать фото" })).toBeNull();
  });

  it("refuses a file of another type and one over 2 MiB, with the design's texts", async () => {
    mount(OWNER);
    await screen.findByRole("dialog");
    pick(new File([new Uint8Array(3)], "a.gif", { type: "image/gif" }));
    const first = await screen.findByRole("alert");
    expect(first.textContent).toContain("Файл не принят");
    expect(first.textContent).toContain("Подойдут JPEG, PNG и WebP.");
    pick(png(2 * 1024 * 1024 + 1));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Файл больше 2 МБ"),
    );
  });

  it("names a picture the webview cannot read or that is too small", async () => {
    mount(OWNER);
    await screen.findByRole("dialog");
    loaded.fail = "tooSmall";
    pick(png());
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Картинка меньше 128×128 px."),
    );
    loaded.fail = "unreadable";
    pick(png());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Файл повреждён"));
  });

  it("crops, previews at 96, 48 and 32, applies and writes only the encoded bytes", async () => {
    const api = fakeHostApi({
      putUserAvatar: vi.fn(async () => photoState(4)),
    });
    const { session } = mount(OWNER, api);
    await screen.findByRole("dialog");
    pick(png());
    const area = await screen.findByRole("group", { name: /Область фото/ });
    expect(area).toBeTruthy();
    const sizes = Array.from(document.querySelectorAll("[data-preview-size]")).map((el) =>
      el.getAttribute("data-preview-size"),
    );
    expect(sizes).toEqual(["96", "48", "32"]);
    // The crop is not applied yet: nothing is written.
    expect(api.putUserAvatar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() =>
      expect(api.putUserAvatar).toHaveBeenCalledWith(expect.any(String), OWNER.id, {
        dataBase64: "QUJD",
      }),
    );
    await waitFor(() => expect(session.refreshUser).toHaveBeenCalled());
    // Back to the idle zone.
    await waitFor(() => expect(screen.queryByRole("group", { name: /Область фото/ })).toBeNull());
  });

  it("maps the host's refusal of the written picture and keeps the crop", async () => {
    const api = fakeHostApi({
      putUserAvatar: vi.fn(async () => {
        throw new HostError({
          kind: "api",
          code: "avatar_not_square",
          message: "no",
          status: 422,
        });
      }),
    });
    mount(OWNER, api);
    await screen.findByRole("dialog");
    pick(png());
    fireEvent.click(await screen.findByRole("button", { name: "Применить" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Фото не сохранено"),
    );
    expect(screen.getByRole("alert").textContent).toContain("только квадратное фото");
    expect(screen.getByRole("group", { name: /Область фото/ })).toBeTruthy();
  });

  it("moves the crop with the arrow keys and zoom with the slider (no write)", async () => {
    mount(OWNER);
    await screen.findByRole("dialog");
    pick(png());
    const area = await screen.findByRole("group", { name: /Область фото/ });
    const imageStyle = () => (area.querySelector("img") as HTMLImageElement).style.left;
    const before = imageStyle();
    fireEvent.change(screen.getByRole("slider", { name: "Масштаб" }), { target: { value: "2" } });
    fireEvent.keyDown(area, { key: "ArrowLeft" });
    expect(imageStyle()).not.toBe(before);
  });
});

describe("avatar cache by avatarVersion", () => {
  function Avatars({ version }: { version: number }) {
    return (
      <>
        <UserAvatar name="Иван Петров" userId={OWNER.id} avatarVersion={version} size={32} />
        <UserAvatar name="Иван Петров" userId={OWNER.id} avatarVersion={version} size={20} />
      </>
    );
  }
  const view = (
    api: ReturnType<typeof fakeHostApi>,
    version: number,
    client = createOfficeQueryClient(),
  ) => (
    <QueryClientProvider client={client}>
      <OfficeSessionProvider value={fakeOfficeSession({ user: OWNER, api })}>
        <Avatars version={version} />
      </OfficeSessionProvider>
    </QueryClientProvider>
  );

  it("reads a photo once per version however many avatars show it, and again on a new version", async () => {
    const api = fakeHostApi({ getUserAvatar: vi.fn(async () => photoState(3)) });
    const client = createOfficeQueryClient();
    const { rerender, container } = render(view(api, 3, client));
    await waitFor(() =>
      expect(container.querySelectorAll("img.user-avatar--photo")).toHaveLength(2),
    );
    expect(api.getUserAvatar).toHaveBeenCalledTimes(1);
    rerender(view(api, 3, client));
    expect(api.getUserAvatar).toHaveBeenCalledTimes(1);
    rerender(view(api, 4, client));
    await waitFor(() => expect(api.getUserAvatar).toHaveBeenCalledTimes(2));
  });

  it("does not read at all for a user without a version, and keeps the initials", () => {
    const api = fakeHostApi();
    render(
      <QueryClientProvider client={createOfficeQueryClient()}>
        <OfficeSessionProvider value={fakeOfficeSession({ user: OWNER, api })}>
          <UserAvatar name="Иван Петров" userId={OWNER.id} avatarVersion={null} />
          <UserAvatar name="Иван Петров" userId={OWNER.id} />
        </OfficeSessionProvider>
      </QueryClientProvider>,
    );
    expect(api.getUserAvatar).not.toHaveBeenCalled();
    expect(screen.getAllByText("ИП")).toHaveLength(2);
  });

  it("keeps the initials when the read fails", async () => {
    const api = fakeHostApi({
      getUserAvatar: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    render(view(api, 5));
    await waitFor(() => expect(api.getUserAvatar).toHaveBeenCalled());
    expect(screen.getAllByText("ИП").length).toBeGreaterThan(0);
  });
});
