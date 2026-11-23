import { render } from "@testing-library/react";
import { Markdown } from "./Markdown";

test("renders an agent report's Markdown as elements, never as HTML", () => {
  const { container } = render(
    <Markdown
      text={[
        "**HS-1: feature idea.**",
        "",
        "- **Found:** `ScenesPage.tsx` renders in order.",
        "  - nested detail",
        "- See [docs](https://example.com) and <img src=x onerror=alert(1)>",
        "",
        "## Next",
        "1. One",
        "2. Two",
        "",
        "```",
        "npm test",
        "```",
      ].join("\n")}
    />,
  );
  expect(container.querySelector("p strong")?.textContent).toBe("HS-1: feature idea.");
  expect(container.querySelectorAll("ul > li")).toHaveLength(3);
  expect(container.querySelector("li code")?.textContent).toBe("ScenesPage.tsx");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(container.querySelector("h3")?.textContent).toBe("Next");
  expect(container.querySelectorAll("ol > li")).toHaveLength(2);
  expect(container.querySelector("pre")?.textContent).toBe("npm test");
});
