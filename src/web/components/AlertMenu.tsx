import type { AlertSettings } from '../live.ts';
import { Icon } from './icons.tsx';
import { Menu } from './Menu.tsx';

/** Alerts while the page is open: desktop notifications and a sound when a monitor goes down. */
export function AlertMenu({
  settings,
  update,
  permission,
}: {
  settings: AlertSettings;
  update: (s: AlertSettings) => Promise<void>;
  permission: string;
}) {
  const on = settings.notify || settings.sound;
  return (
    <Menu
      summary={<Icon name="bell" />}
      summaryClass={`btn btn-icon${on ? ' btn-on' : ''}`}
      label="Alerts"
      title="Alerts when a monitor goes down"
    >
      <div className="menu-title">When a monitor goes down, while this page is open</div>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.notify}
          disabled={permission === 'unsupported' || permission === 'denied'}
          onChange={(e) => void update({ ...settings, notify: e.target.checked })}
        />
        Desktop notification
      </label>
      {permission === 'denied' && <div className="small warn-text">Notifications are blocked for this site.</div>}
      <label className="check">
        <input
          type="checkbox"
          checked={settings.sound}
          onChange={(e) => void update({ ...settings, sound: e.target.checked })}
        />
        Sound
      </label>
      <div className="small muted">Kept in this browser.</div>
    </Menu>
  );
}
