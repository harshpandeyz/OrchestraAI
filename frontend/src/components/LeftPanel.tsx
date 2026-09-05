// Back-compat: left navigation is now the console journey sidebar.
// Existing imports of LeftPanel keep working.
import { ConsoleSidebar } from '../console/ConsoleSidebar';

export function LeftPanel() {
  return <ConsoleSidebar />;
}
