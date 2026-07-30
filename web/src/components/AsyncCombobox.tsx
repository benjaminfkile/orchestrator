// A Fluent UI v9 Combobox wrapper that turns any "magic string" field into a
// fetched, editable dropdown without every call site re-implementing the
// fetch/loading/error/empty dance.
//
// Design rules (load-bearing):
//   - Options load via an injected `load: () => Promise<Option[]>`. The loader
//     identity may change every render (inline arrows are the norm); we hold it
//     in a ref so a fresh loader never re-triggers the mount fetch.
//   - FREEFORM by default: the user can ALWAYS commit a value that is not in
//     the list. These fields configure things that may not exist yet, so a
//     freeform value must never be trapped behind "no matches".
//   - Single- and multi-select share one component; the value/onChange types
//     narrow on the `multiselect` prop.
//   - Loading / error / empty are surfaced in-place; a manual refresh
//     affordance re-runs the loader on demand.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Combobox,
  Field,
  makeStyles,
  Option,
  Spinner,
  Tag,
  TagGroup,
  tokens,
} from "@fluentui/react-components";

/** One selectable option. `label` is what the user sees; `value` is committed. */
export interface AsyncComboboxOption {
  value: string;
  label?: string;
}

interface BaseProps {
  /** Loads the option list. May be a fresh closure each render (held in a ref). */
  load: () => Promise<AsyncComboboxOption[]>;
  /**
   * Called after each SUCCESSFUL load with the freshly-loaded options. Lets a
   * parent react to what came back (e.g. auto-select when exactly one option
   * exists) without duplicating the fetch. Held in a ref, so an inline closure
   * is fine.
   */
  onLoaded?: (options: AsyncComboboxOption[]) => void;
  /** Allow committing a value not in the list. Defaults to `true`. */
  freeform?: boolean;
  /** Fetch on mount. Defaults to `true`; set false to defer until refresh. */
  autoLoad?: boolean;
  /** Field label rendered above the control. */
  label?: string;
  /** Optional help text rendered under the control (Field `hint`). */
  hint?: string;
  /** Accessible name for the input when there is no visible `label`. */
  "aria-label"?: string;
  placeholder?: string;
  disabled?: boolean;
  /** `id` for the underlying input (label association / testing). */
  id?: string;
}

interface SingleProps extends BaseProps {
  multiselect?: false;
  /** The currently committed value (empty string when unset). */
  value?: string;
  onChange?: (value: string) => void;
}

interface MultiProps extends BaseProps {
  multiselect: true;
  /** The currently committed values. */
  value?: string[];
  onChange?: (values: string[]) => void;
}

export type AsyncComboboxProps = SingleProps | MultiProps;

type LoadStatus = "idle" | "loading" | "loaded" | "error";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "flex-end",
    gap: tokens.spacingHorizontalXS,
  },
  combobox: {
    flexGrow: 1,
    minWidth: 0,
  },
  refresh: {
    flexShrink: 0,
  },
  tags: {
    marginTop: tokens.spacingVerticalXS,
  },
});

/** Display text for a value: the matching option's label, else the raw value. */
function labelFor(value: string, options: AsyncComboboxOption[]): string {
  const match = options.find((o) => o.value === value);
  return (match && (match.label ?? match.value)) || value;
}

export function AsyncCombobox(props: AsyncComboboxProps): JSX.Element {
  const {
    load,
    onLoaded,
    freeform = true,
    autoLoad = true,
    label,
    hint,
    placeholder,
    disabled,
    id,
    multiselect = false,
  } = props;
  const ariaLabel = props["aria-label"];
  const styles = useStyles();

  const selected: string[] = multiselect
    ? ((props as MultiProps).value ?? [])
    : [];
  const singleValue: string = multiselect
    ? ""
    : ((props as SingleProps).value ?? "");

  const [options, setOptions] = useState<AsyncComboboxOption[]>([]);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // The input's editable text: the filter query in multi-select, and the live
  // value in single-select (kept in sync with the committed value below).
  const [query, setQuery] = useState<string>(() =>
    multiselect ? "" : singleValue,
  );

  // Hold the (possibly re-created every render) loader in a ref so `reload`
  // stays referentially stable and the mount effect never loops.
  const loadRef = useRef(load);
  loadRef.current = load;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const reqIdRef = useRef(0);
  // While the input is focused we never overwrite what the user is typing (e.g.
  // when the initial load resolves mid-edit and relabels the committed value).
  const focusedRef = useRef(false);

  const reload = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setStatus("loading");
    setError(null);
    try {
      const opts = await loadRef.current();
      if (reqId !== reqIdRef.current) return; // superseded by a newer load
      setOptions(opts);
      setStatus("loaded");
      onLoadedRef.current?.(opts);
    } catch (e) {
      if (reqId !== reqIdRef.current) return;
      setOptions([]);
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (autoLoad) void reload();
    // Intentionally mount-only (plus autoLoad toggles); `reload` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad]);

  // Keep the single-select input text mirroring the committed value, including
  // after options load (so a value picked before labels arrived gets labeled).
  // Skipped while focused so it never clobbers in-progress typing.
  useEffect(() => {
    if (!multiselect && !focusedRef.current)
      setQuery(labelFor(singleValue, options));
  }, [multiselect, singleValue, options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      (o.label ?? o.value).toLowerCase().includes(q),
    );
  }, [options, query]);

  const emitSingle = (props as SingleProps).onChange;
  const emitMulti = (props as MultiProps).onChange;

  const onOptionSelect = useCallback(
    (
      _e: unknown,
      data: { optionValue?: string; selectedOptions: string[] },
    ) => {
      if (multiselect) {
        emitMulti?.(data.selectedOptions);
        setQuery("");
      } else {
        const v = data.optionValue ?? "";
        emitSingle?.(v);
        setQuery(labelFor(v, options));
      }
    },
    [multiselect, emitMulti, emitSingle, options],
  );

  const onInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
    [],
  );

  // Commit a freeform (typed, not-in-list) single value on blur or Enter.
  const commitSingleFreeform = useCallback(() => {
    if (multiselect || !freeform) return;
    const v = query.trim();
    // Compare against the current DISPLAY text: after selecting an option the
    // query holds the label while the value holds the id — those are "equal".
    if (v !== labelFor(singleValue, options)) emitSingle?.(v);
  }, [multiselect, freeform, query, singleValue, options, emitSingle]);

  // Add a freeform (typed, not-in-list) value as a tag on Enter, in multi mode.
  const addMultiFreeform = useCallback((): boolean => {
    if (!multiselect || !freeform) return false;
    const v = query.trim();
    if (!v || selected.includes(v)) return false;
    const matchesOption = options.some(
      (o) => o.value === v || (o.label ?? o.value) === v,
    );
    if (matchesOption) return false; // let normal selection handle it
    emitMulti?.([...selected, v]);
    setQuery("");
    return true;
  }, [multiselect, freeform, query, selected, options, emitMulti]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      if (multiselect) {
        if (addMultiFreeform()) e.preventDefault();
      } else {
        commitSingleFreeform();
      }
    },
    [multiselect, addMultiFreeform, commitSingleFreeform],
  );

  const onFocus = useCallback(() => {
    focusedRef.current = true;
  }, []);

  const onBlur = useCallback(() => {
    focusedRef.current = false;
    if (multiselect) return;
    if (freeform) commitSingleFreeform();
    // Non-freeform: discard un-committed typing, restore the committed label.
    else setQuery(labelFor(singleValue, options));
  }, [multiselect, freeform, commitSingleFreeform, singleValue, options]);

  const removeTag = useCallback(
    (value: string) => emitMulti?.(selected.filter((s) => s !== value)),
    [emitMulti, selected],
  );

  const listboxChildren = () => {
    if (status === "loading")
      return (
        <Option key="__loading" value="__loading" disabled text="Loading options…">
          Loading options…
        </Option>
      );
    if (status === "error")
      return (
        <Option key="__error" value="__error" disabled text="Couldn't load options">
          Couldn't load options — type to enter a value
        </Option>
      );
    if (options.length === 0)
      return (
        <Option key="__empty" value="__empty" disabled text="No options">
          No options — type to enter a value
        </Option>
      );
    if (filtered.length === 0)
      return (
        <Option key="__nomatch" value="__nomatch" disabled text="No matches">
          No matches — type to enter a value
        </Option>
      );
    return filtered.map((o) => (
      <Option key={o.value} value={o.value} text={o.label ?? o.value}>
        {o.label ?? o.value}
      </Option>
    ));
  };

  return (
    <Field
      label={label}
      hint={hint}
      validationState={status === "error" ? "error" : "none"}
      validationMessage={
        status === "error"
          ? `Couldn't load options${error ? `: ${error}` : ""}`
          : undefined
      }
    >
      <div className={styles.root}>
        <Combobox
          className={styles.combobox}
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          disabled={disabled}
          freeform={freeform}
          // Render the listbox INLINE (not portaled to <body>). Portaling breaks
          // inside a modal OverlayDrawer: the popup layers above a full-viewport
          // scrim that hides the drawer, leaving only the listbox visible on a
          // blank background. Inline keeps it within the drawer's stacking context.
          inlinePopup
          multiselect={multiselect}
          selectedOptions={multiselect ? selected : singleValue ? [singleValue] : []}
          value={query}
          onOptionSelect={onOptionSelect}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          {listboxChildren()}
        </Combobox>
        <Button
          className={styles.refresh}
          appearance="subtle"
          aria-label="Refresh options"
          disabled={disabled || status === "loading"}
          onClick={() => void reload()}
          icon={
            status === "loading" ? (
              <Spinner size="tiny" aria-label="Loading options" />
            ) : (
              <span aria-hidden>↻</span>
            )
          }
        />
      </div>
      {multiselect && selected.length > 0 && (
        <TagGroup
          className={styles.tags}
          onDismiss={(_e, data) => removeTag(String(data.value))}
        >
          {selected.map((s) => (
            <Tag
              key={s}
              value={s}
              dismissible
              dismissIcon={{ "aria-label": `Remove ${labelFor(s, options)}` }}
            >
              {labelFor(s, options)}
            </Tag>
          ))}
        </TagGroup>
      )}
    </Field>
  );
}
