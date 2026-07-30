import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModuleConfig,
  putModuleConfig,
  type DatadogModuleConfig,
  type ProducerStatus,
} from "../modules";
import { getSecretNames } from "../discovery";
import { DatadogModuleCard } from "./DatadogModuleCard";

// Mock the data layer wholesale; the card's only inputs are these calls.
vi.mock("../modules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules")>()),
  getModuleConfig: vi.fn(),
  putModuleConfig: vi.fn(),
}));

vi.mock("../discovery", () => ({
  getSecretNames: vi.fn(),
}));

const mockGetModuleConfig = vi.mocked(getModuleConfig);
const mockPutModuleConfig = vi.mocked(putModuleConfig);
const mockGetSecretNames = vi.mocked(getSecretNames);

const PRODUCERS: ProducerStatus[] = [
  {
    producerId: "datadog.logwatch",
    trigger: { kind: "interval", seconds: 60 },
    lastTickAt: 1_700_000_000_000,
    lastError: "boom while polling",
    nextFireAt: 1_700_000_060_000,
  },
  {
    producerId: "datadog.monitor",
    trigger: null,
    lastTickAt: null,
    lastError: null,
    nextFireAt: null,
  },
];

function setConfig(config: DatadogModuleConfig | null) {
  mockGetModuleConfig.mockResolvedValue({ module_id: "datadog", config });
}

beforeEach(() => {
  setConfig(null);
  mockPutModuleConfig.mockResolvedValue({ module_id: "datadog", config: {} });
  mockGetSecretNames.mockResolvedValue(["DD_API_KEY", "DD_APP_KEY"]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DatadogModuleCard", () => {
  it("renders both producers' status", async () => {
    render(<DatadogModuleCard producers={PRODUCERS} />);
    const status = await screen.findByTestId("datadog-status");
    expect(status.textContent).toContain("datadog.logwatch");
    expect(status.textContent).toContain("every 60s");
    expect(status.textContent).toContain("boom while polling");
    expect(status.textContent).toContain("datadog.monitor");
    expect(status.textContent).toContain("not scheduled");
  });

  it("prefills the form from the stored config", async () => {
    setConfig({
      enabled: true,
      site: "us5.datadoghq.com",
      api_key_secret_ref: "DD_API_KEY",
      app_key_secret_ref: "DD_APP_KEY",
      interval_seconds: 120,
      monitors: { enabled: true, monitor_tags: ["team:platform"] },
      watches: [
        {
          name: "errors",
          query: "status:error service:web",
          group_by: "@http.status_code",
          window_seconds: 300,
          detect: {
            min_count: 10,
            spike_multiplier: 3,
            baseline_windows: 6,
            novel_groups: true,
          },
          sample_limit: 5,
        },
      ],
    });

    render(<DatadogModuleCard producers={PRODUCERS} />);

    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Site" }) as HTMLInputElement).value).toBe(
        "us5.datadoghq.com",
      ),
    );
    expect(
      (screen.getByRole("switch", { name: "Enabled" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByRole("spinbutton", {
        name: "Datadog poll interval (seconds)",
      }) as HTMLInputElement).value,
    ).toBe("120");
    expect(
      (screen.getByRole("switch", {
        name: "Watch monitor transitions",
      }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText("team:platform")).toBeTruthy();

    // The watch row is fully prefilled.
    expect((screen.getByRole("textbox", { name: "Watch 1 name" }) as HTMLInputElement).value).toBe(
      "errors",
    );
    expect(
      (screen.getByRole("textbox", { name: "Watch 1 query" }) as HTMLInputElement).value,
    ).toBe("status:error service:web");
    expect(
      (screen.getByRole("spinbutton", { name: "Watch 1 min count" }) as HTMLInputElement).value,
    ).toBe("10");
    expect(
      (screen.getByRole("switch", { name: "Watch 1 novel groups" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("adds a watch, edits every field, and saves the assembled config", async () => {
    render(<DatadogModuleCard producers={PRODUCERS} />);
    await screen.findByRole("textbox", { name: "Site" });

    // Connection + interval.
    fireEvent.change(screen.getByRole("textbox", { name: "Site" }), {
      target: { value: "datadoghq.eu" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Datadog poll interval (seconds)" }),
      { target: { value: "90" } },
    );

    // Secret refs are freeform pickers; a typed value commits on blur.
    const apiKey = screen.getByRole("combobox", { name: "Datadog API key secret" });
    fireEvent.focus(apiKey);
    fireEvent.change(apiKey, { target: { value: "DD_API_KEY" } });
    fireEvent.blur(apiKey);
    const appKey = screen.getByRole("combobox", {
      name: "Datadog Application key secret",
    });
    fireEvent.focus(appKey);
    fireEvent.change(appKey, { target: { value: "DD_APP_KEY" } });
    fireEvent.blur(appKey);

    // Monitors sub-section.
    fireEvent.click(screen.getByRole("switch", { name: "Watch monitor transitions" }));
    const tags = screen.getByRole("combobox", { name: "Monitor tags" });
    fireEvent.focus(tags);
    fireEvent.change(tags, { target: { value: "team:platform" } });
    fireEvent.keyDown(tags, { key: "Enter" });

    // Add and fill a watch row.
    fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Watch 1 name" }), {
      target: { value: "errors" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Watch 1 query" }), {
      target: { value: "status:error" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Watch 1 group by" }), {
      target: { value: "@service" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Watch 1 window seconds" }), {
      target: { value: "300" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Watch 1 min count" }), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Watch 1 spike multiplier" }), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Watch 1 baseline windows" }), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Watch 1 sample limit" }), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Watch 1 novel groups" }));

    fireEvent.click(screen.getByRole("button", { name: "Save Datadog config" }));

    await waitFor(() => expect(mockPutModuleConfig).toHaveBeenCalledTimes(1));
    expect(mockPutModuleConfig).toHaveBeenCalledWith("datadog", {
      enabled: true,
      site: "datadoghq.eu",
      api_key_secret_ref: "DD_API_KEY",
      app_key_secret_ref: "DD_APP_KEY",
      interval_seconds: 90,
      monitors: { enabled: true, monitor_tags: ["team:platform"] },
      watches: [
        {
          name: "errors",
          query: "status:error",
          group_by: "@service",
          window_seconds: 300,
          sample_limit: 5,
          detect: {
            min_count: 10,
            spike_multiplier: 3,
            baseline_windows: 6,
            novel_groups: true,
          },
        },
      ],
    });
    // The success indicator appears after the round-trip.
    expect((await screen.findByRole("status")).textContent).toContain("Saved");
  });

  it("removes a watch row", async () => {
    setConfig({
      watches: [
        { name: "a", query: "q", group_by: "g" },
        { name: "b", query: "q", group_by: "g" },
      ],
    });
    render(<DatadogModuleCard producers={PRODUCERS} />);
    await screen.findByTestId("datadog-watch-0");
    expect(screen.getByTestId("datadog-watch-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove watch 1" }));
    expect(screen.queryByTestId("datadog-watch-1")).toBeNull();
    expect(screen.getByTestId("datadog-watch-0")).toBeTruthy();
  });

  it("surfaces the router's 400 validation message inline", async () => {
    mockPutModuleConfig.mockRejectedValueOnce(
      new Error("watches[0].name must be a non-empty string"),
    );
    render(<DatadogModuleCard producers={PRODUCERS} />);
    await screen.findByRole("textbox", { name: "Site" });

    fireEvent.click(screen.getByRole("button", { name: "Add watch" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Datadog config" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("must be a non-empty string");
  });

  it("warns when a referenced secret name is not in the store", async () => {
    mockGetSecretNames.mockResolvedValue(["other_secret"]);
    setConfig({ api_key_secret_ref: "missing_key" });
    render(<DatadogModuleCard producers={PRODUCERS} />);
    await screen.findByRole("combobox", { name: "Datadog API key secret" });

    const note = await screen.findByRole("note");
    expect(note.textContent).toContain("missing_key");
    expect(note.textContent).toContain("isn't in the secret store");
  });

  it("does not warn when the referenced secret name exists", async () => {
    mockGetSecretNames.mockResolvedValue(["DD_API_KEY"]);
    setConfig({ api_key_secret_ref: "DD_API_KEY" });
    render(<DatadogModuleCard producers={PRODUCERS} />);
    await screen.findByRole("combobox", { name: "Datadog API key secret" });
    await waitFor(() => expect(mockGetSecretNames).toHaveBeenCalled());
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("omits blank connection + monitors + watches from the payload", async () => {
    render(<DatadogModuleCard producers={PRODUCERS} />);
    await screen.findByRole("textbox", { name: "Site" });

    fireEvent.click(screen.getByRole("button", { name: "Save Datadog config" }));
    await waitFor(() => expect(mockPutModuleConfig).toHaveBeenCalledTimes(1));
    expect(mockPutModuleConfig).toHaveBeenCalledWith("datadog", { enabled: false });
  });
});
