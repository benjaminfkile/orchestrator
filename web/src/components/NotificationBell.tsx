import {
  Button,
  CounterBadge,
  makeStyles,
} from "@fluentui/react-components";
import { Alert24Regular } from "@fluentui/react-icons";
import { useNavigate } from "react-router-dom";

import { useNotifications } from "./NotificationsProvider";

const useStyles = makeStyles({
  root: {
    position: "relative",
    display: "inline-flex",
  },
  // Overlap the badge onto the top-right corner of the bell button.
  badge: {
    position: "absolute",
    top: "2px",
    right: "2px",
    pointerEvents: "none",
  },
});

/**
 * Nav bell that opens the inbox and shows a live unread-count badge. The count
 * is owned by {@link NotificationsProvider} (seeded from the API, kept live by
 * the SSE stream and mark-read actions); this component only renders it and
 * routes to the inbox on click.
 */
export function NotificationBell() {
  const styles = useStyles();
  const navigate = useNavigate();
  const { unreadCount } = useNotifications();

  const label =
    unreadCount > 0
      ? `Notifications, ${unreadCount} unread`
      : "Notifications";

  return (
    <div className={styles.root}>
      <Button
        appearance="subtle"
        icon={<Alert24Regular />}
        aria-label={label}
        onClick={() => navigate("/notifications")}
      />
      {unreadCount > 0 && (
        <CounterBadge
          className={styles.badge}
          appearance="filled"
          color="danger"
          size="small"
          count={unreadCount}
          overflowCount={99}
        />
      )}
    </div>
  );
}
