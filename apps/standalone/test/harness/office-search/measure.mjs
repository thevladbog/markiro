/* global document, innerWidth, innerHeight, getComputedStyle */
const { chromium } = await import(process.env.PLAYWRIGHT_CORE);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const problems = [];
const observed = [];
try {
  for (const width of [390, 800, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.goto(`${process.argv[2]}/test/harness/office-search/index.html?theme=${theme}`);
      await page.getByText("Закрыт", { exact: true }).waitFor();
      const dimensions = await page.locator(".mk-tag").evaluate((chip) => ({
        width: chip.getBoundingClientRect().width,
        height: chip.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      if (dimensions.width > 180 || dimensions.height > 36 || dimensions.overflow)
        problems.push({ width, theme, ...dimensions });
      if (await page.locator("header").getByRole("textbox").count())
        problems.push({ width, theme, persistentHeaderTextbox: true });
      const headerOverflow = await page.locator("header").evaluate((header) => {
        const bounds = header.getBoundingClientRect();
        return [...header.children].some((part) => {
          const box = part.getBoundingClientRect();
          return (
            box.left < bounds.left - 1 ||
            box.right > bounds.right + 1 ||
            part.scrollWidth > part.clientWidth + 1
          );
        });
      });
      if (headerOverflow) problems.push({ width, theme, headerOverflow: true });
      for (const selector of [".host-dot__button--compact", ".office-sync-dot"]) {
        const dot = page.locator(selector);
        if ((await dot.count()) !== 1) problems.push({ width, theme, missingHealthyDot: selector });
        else {
          const bounds = await dot.boundingBox();
          const visualDot = await dot.locator(".status-dot--ok").boundingBox();
          if (
            !bounds ||
            bounds.width > 56 ||
            bounds.height > 56 ||
            !visualDot ||
            visualDot.width > 16 ||
            visualDot.height > 16
          )
            problems.push({ width, theme, expandedHealthyDot: selector, bounds });
        }
      }
      const nav = page.getByRole("navigation", { name: "Разделы офиса" });
      const trigger = nav.getByRole("button", { name: "Поиск по системе", exact: true });
      const menu = await trigger.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const label = button.querySelector(".office-menu__label");
        const labelVisible =
          label !== null &&
          getComputedStyle(label).display !== "none" &&
          label.getBoundingClientRect().width > 1 &&
          label.getBoundingClientRect().height > 1;
        const firstLink = button.closest("nav")?.querySelector("a");
        return {
          labelVisible,
          label: label?.textContent,
          collapsed: button.closest("nav")?.classList.contains("office-menu--collapsed"),
          beforeFirstLink:
            firstLink !== null &&
            firstLink !== undefined &&
            Boolean(button.compareDocumentPosition(firstLink) & 4),
          outside: bounds.x < 0 || bounds.right > innerWidth,
        };
      });
      if (
        menu.collapsed !== width < 1366 ||
        menu.labelVisible !== width >= 1366 ||
        !menu.beforeFirstLink ||
        menu.outside ||
        (width >= 1366 && menu.label !== "Поиск")
      )
        problems.push({ width, theme, menu });
      const spacing = await nav.evaluate((menu) => {
        const links = [...menu.querySelectorAll("li > .office-menu__link")];
        const touching = links.some((link) => {
          const next = link.parentElement?.nextElementSibling?.querySelector(".office-menu__link");
          return next && next.getBoundingClientRect().top - link.getBoundingClientRect().bottom < 4;
        });
        const crampedHeadings = [...menu.querySelectorAll(".office-menu__section")].some(
          (heading) => {
            const label = heading.querySelector("span");
            const next = heading.nextElementSibling?.querySelector(".office-menu__link");
            return (
              label &&
              getComputedStyle(label).display !== "none" &&
              next &&
              next.getBoundingClientRect().top - label.getBoundingClientRect().bottom < 12
            );
          },
        );
        return { touching, crampedHeadings };
      });
      if (spacing.touching || spacing.crampedHeadings) problems.push({ width, theme, spacing });
      if (await page.getByRole("button", { name: "Выйти в цех", exact: true }).count())
        problems.push({ width, theme, standaloneFloorExit: true });
      if (process.env.OFFICE_SCREENSHOTS && (width === 390 || width === 1280 || width === 1440)) {
        await page.screenshot({
          path: `${process.env.OFFICE_SCREENSHOTS}/office-sidebar-idle-${width}-${theme}.png`,
        });
        await page.locator("header").screenshot({
          path: `${process.env.OFFICE_SCREENSHOTS}/office-header-strip-${width}-${theme}.png`,
        });
      }
      await page.locator(".user-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Выйти в цех", exact: true }).waitFor();
      const profileBounds = await page.getByRole("menu").boundingBox();
      if (!profileBounds || profileBounds.x < 0 || profileBounds.x + profileBounds.width > width)
        problems.push({ width, theme, profileBounds });
      await page.keyboard.press("Escape");
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Поиск по системе", exact: true });
      await dialog.waitFor();
      const input = dialog.getByRole("textbox", { name: "Поиск по системе", exact: true });
      await input.waitFor();
      if (!(await input.evaluate((element) => element === document.activeElement)))
        problems.push({ width, theme, searchInputNotFocused: true });
      await input.fill("Палет");
      await dialog.getByRole("button", { name: "Найти", exact: true }).click();
      await dialog.getByRole("region", { name: "Документы", exact: true }).waitFor();
      const fit = await dialog.evaluate((modal) => {
        const box = modal.getBoundingClientRect();
        const results = modal.querySelector(".office-search-results");
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          clipped:
            box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight,
          contentOverflow: modal.scrollWidth > modal.clientWidth,
          resultsOverflow: results !== null && results.scrollWidth > results.clientWidth,
        };
      });
      if (Object.values(fit).some(Boolean)) problems.push({ width, theme, search: fit });
      if (process.env.OFFICE_SCREENSHOTS && (width === 390 || width === 1280 || width === 1440))
        await page.screenshot({
          path: `${process.env.OFFICE_SCREENSHOTS}/office-search-${width}-${theme}.png`,
        });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      if (!(await trigger.evaluate((element) => element === document.activeElement)))
        problems.push({ width, theme, searchTriggerFocusNotReturned: true });
      observed.push({ width, theme, menu, search: fit });
    }
  }
  console.log(JSON.stringify({ problems, observed }));
  process.exitCode = problems.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
