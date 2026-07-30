import { render } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
// Importing the global reset must not throw or break rendering. Vite resolves
// the stylesheet at import time; a broken/mis-pathed import would fail here.
import "./index.css";

describe("global stylesheet", () => {
  it("imports without breaking rendering", () => {
    const { container } = render(
      <FluentProvider theme={webLightTheme}>
        <div>ok</div>
      </FluentProvider>,
    );
    expect(container.textContent).toContain("ok");
  });
});
