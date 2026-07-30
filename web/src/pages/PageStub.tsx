import { Title1 } from "@fluentui/react-components";

/**
 * Placeholder page body used by every route until its real page lands in a
 * follow-up task. Renders the page title as an H1 so route-switching is
 * observable in tests and in the browser.
 */
export function PageStub({ title }: { title: string }) {
  return (
    <section>
      <Title1 as="h1">{title}</Title1>
    </section>
  );
}
