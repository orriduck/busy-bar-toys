import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Navigation, type Page } from "../ui/navigation";

describe("icon-only navigation semantics", () => {
  it.each<Page>(["display", "services", "configuration", "device"])(
    "keeps every destination named and one current on %s",
    (page) => {
      const html = renderToStaticMarkup(
        createElement(Navigation, { page, onPage: () => {} }),
      );
      const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(
        (match) => match[0],
      );
      expect(buttons).toHaveLength(4);
      for (const label of ["Display", "Services", "Configuration", "Device"])
        expect(
          buttons.some((button) => button.includes(`aria-label="${label}"`)),
        ).toBe(true);
      const current = buttons.filter((button) =>
        button.includes('aria-current="page"'),
      );
      expect(current).toHaveLength(1);
      expect(current[0]).toContain(
        `aria-label="${page[0].toUpperCase()}${page.slice(1)}"`,
      );
      expect(html).toContain('class="navigation-selection" aria-hidden="true"');
    },
  );
});
