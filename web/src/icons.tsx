import type { ReactNode } from "react";

/** Small line icons drawn on a 16px grid; they inherit the current text color. */
function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const PlusIcon = () => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const HomeIcon = () => (
  <Icon>
    <path d="M2.5 7.2 8 2.8l5.5 4.4V13a.7.7 0 0 1-.7.7H9.6V10H6.4v3.7H3.2a.7.7 0 0 1-.7-.7z" />
  </Icon>
);

export const MemoryIcon = () => (
  <Icon>
    <path d="M3 2.8h7.6L13 5.2v8H3z" />
    <path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
  </Icon>
);

export const ChevronRight = () => (
  <Icon size={12}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Icon>
);

export const ChevronLeft = () => (
  <Icon size={20}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Icon>
);

export const PanelIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M10 3v10" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="m3.2 8.4 3 3 6.6-6.8" />
  </Icon>
);

export const AttachIcon = () => (
  <Icon size={18}>
    <path d="M13.2 7.4 8 12.6a3 3 0 0 1-4.3-4.2l5.4-5.5a2 2 0 0 1 2.9 2.8l-5.3 5.4a1 1 0 0 1-1.5-1.4l4.8-4.9" />
  </Icon>
);

export const ArrowUpIcon = () => (
  <Icon>
    <path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" />
  </Icon>
);

export const StopIcon = () => (
  <svg className="icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1.5" y="1.5" width="9" height="9" rx="1.8" fill="currentColor" />
  </svg>
);

export const CloseIcon = () => (
  <Icon>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const ClockIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 5v3.2l2 1.3" />
  </Icon>
);

export const StatusIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" stroke="none" />
  </Icon>
);

export const BellIcon = () => (
  <Icon>
    <path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1 1.1H3z" />
    <path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" />
  </Icon>
);

export const AlertIcon = () => (
  <Icon>
    <path d="M8 2.6 14 13H2z" />
    <path d="M8 6.6v3M8 11.4v.1" />
  </Icon>
);

export const ArrowUpRightIcon = () => (
  <Icon size={14}>
    <path d="M5 11 11 5M6 5h5v5" />
  </Icon>
);

export const CalendarIcon = () => (
  <Icon>
    <rect x="2.5" y="3.2" width="11" height="10.3" rx="1.6" />
    <path d="M2.5 6.6h11M5.4 2v2.4M10.6 2v2.4" />
  </Icon>
);

export const MailIcon = () => (
  <Icon>
    <rect x="2.2" y="3.6" width="11.6" height="8.8" rx="1.6" />
    <path d="m2.6 4.4 5.4 4.2 5.4-4.2" />
  </Icon>
);

export const GlobeIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M2.4 8h11.2M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.4z" />
  </Icon>
);

export const SparkIcon = () => (
  <Icon>
    <path d="M8 2.2c.4 2.9 1.3 3.8 4.2 4.2-2.9.4-3.8 1.3-4.2 4.2-.4-2.9-1.3-3.8-4.2-4.2 2.9-.4 3.8-1.3 4.2-4.2z" />
    <path d="M12.3 10.6c.2 1.2.5 1.5 1.7 1.7-1.2.2-1.5.5-1.7 1.7-.2-1.2-.5-1.5-1.7-1.7 1.2-.2 1.5-.5 1.7-1.7z" />
  </Icon>
);

export const SunIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="2.6" />
    <path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" />
  </Icon>
);

export const XCircleIcon = () => (
  <Icon>
    <circle cx="8" cy="8" r="5.6" />
    <path d="m6 6 4 4M10 6l-4 4" />
  </Icon>
);

/** Icon for the kind of outward action a tool performs. */
export function ToolIcon({ tool }: { tool: string }) {
  if (tool.includes("event") || tool.includes("invite")) return <CalendarIcon />;
  if (tool.includes("email")) return <MailIcon />;
  if (tool.startsWith("browser")) return <GlobeIcon />;
  return <SparkIcon />;
}
