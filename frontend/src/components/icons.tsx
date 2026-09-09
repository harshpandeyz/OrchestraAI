// OrchestraAI icon system — one visual grammar.
// 16px stroke icons, 1.7px stroke, round caps/joins, currentColor.
// Never use raw Unicode glyphs as primary controls; these replace ☰ ☾ ☀ ◧ ✕ + − etc.
import React from 'react';

type P = { size?: number; className?: string; style?: React.CSSProperties };

function Svg({ size = 16, className, style, children, label }: P & { children: React.ReactNode; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: P) => (
  <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 14 14" /></Svg>
);
export const IconX = (p: P) => (
  <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>
);
export const IconChevronLeft = (p: P) => (
  <Svg {...p}><path d="M10 3 5 8l5 5" /></Svg>
);
export const IconChevronRight = (p: P) => (
  <Svg {...p}><path d="M6 3l5 5-5 5" /></Svg>
);
export const IconChevronDown = (p: P) => (
  <Svg {...p}><path d="M3 6l5 5 5-5" /></Svg>
);
export const IconPanelLeft = (p: P) => (
  <Svg {...p}><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M6.2 2.5v11" /></Svg>
);
export const IconPanelRight = (p: P) => (
  <Svg {...p}><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M9.8 2.5v11" /></Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}><circle cx="8" cy="8" r="3.2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" /></Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}><path d="M13.2 9.5A5.3 5.3 0 0 1 6.5 2.8 5.3 5.3 0 1 0 13.2 9.5Z" /></Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p}><path d="M14 2 7.3 8.7M14 2 9.6 14l-2.3-5.3L2 6.4 14 2Z" /></Svg>
);
export const IconStop = (p: P) => (
  <Svg {...p}><rect x="4" y="4" width="8" height="8" rx="1.6" /></Svg>
);
export const IconRetry = (p: P) => (
  <Svg {...p}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.8v2.8h-2.8" /></Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 3.5v-1h-7v8h1" /></Svg>
);
export const IconDots = (p: P) => (
  <Svg {...p}><circle cx="3.5" cy="8" r="0.4" fill="currentColor" /><circle cx="8" cy="8" r="0.4" fill="currentColor" /><circle cx="12.5" cy="8" r="0.4" fill="currentColor" /></Svg>
);
export const IconModel = (p: P) => (
  <Svg {...p}><path d="M8 2 13.5 5v6L8 14 2.5 11V5L8 2Z" /><path d="M8 2v6m0 0L2.5 5M8 8l5.5-3" /></Svg>
);
export const IconTool = (p: P) => (
  <Svg {...p}><path d="M9.8 2.6a3 3 0 0 0-3.9 3.9L2.5 9.9l3.6 3.6 3.4-3.4a3 3 0 0 0 3.9-3.9L11 8.6 7.4 5 9.8 2.6Z" /></Svg>
);
export const IconMemory = (p: P) => (
  <Svg {...p}><ellipse cx="8" cy="4.5" rx="4.5" ry="2" /><path d="M3.5 4.5v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7M3.5 8c0 1.1 2 2 4.5 2s4.5-.9 4.5-2" /></Svg>
);
export const IconEval = (p: P) => (
  <Svg {...p}><path d="M2.5 13.5 6 9l2.5 2.5 5-7" /><path d="M10.5 4.5h3v3" /></Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3" /></Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}><path d="M3 8.5 6.5 12 13 4.5" /></Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}><path d="M8 2 14.5 13.5h-13L8 2Z" /><path d="M8 6.5v3.2M8 11.8v.2" /></Svg>
);
export const IconActivity = (p: P) => (
  <Svg {...p}><path d="M1.8 8h2.4l1.4-3.4 2.7 6.8 1.7-4.2h4.2" /></Svg>
);
export const IconFile = (p: P) => (
  <Svg {...p}><path d="M4 2.2h5l3 3v8.6H4V2.2Z" /><path d="M9 2.2v3h3M6 8h4M6 10.5h4" /></Svg>
);
export const IconCreditCard = (p: P) => (
  <Svg {...p}><rect x="2" y="3.5" width="12" height="9" rx="1.7" /><path d="M2 6.5h12M5 10h2" /></Svg>
);
export const IconArrowDown = (p: P) => (
  <Svg {...p}><path d="M8 2.5v11M3.5 9.5 8 14l4.5-4.5" /></Svg>
);
export const IconCollapse = (p: P) => (
  <Svg {...p}><path d="M10 3 5 8l5 5" /></Svg>
);
export const IconHome = (p: P) => (
  <Svg {...p}><path d="M2.5 7.2 8 2.8l5.5 4.4" /><path d="M4 6.6V13h8V6.6" /></Svg>
);
export const IconRuns = (p: P) => (
  <Svg {...p}><circle cx="8" cy="8" r="5.6" /><path d="M6.7 5.7v4.6L10.3 8z" /></Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}><path d="M2 4.4h4.2l1.4 2H14v5.2H2z" /></Svg>
);
export const IconTrendDown = (p: P) => (
  <Svg {...p}><path d="M2.5 3.5 7 8l3-3 3.5 3.5" /><path d="M10.5 8.5h3v-3" /></Svg>
);
export const IconCpu = (p: P) => (
  <Svg {...p}><rect x="3.5" y="3.5" width="9" height="9" rx="2" /><rect x="6.8" y="6.8" width="2.4" height="2.4" rx="0.6" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M4.8 4.8l1.2 1.2M10 10l1.2 1.2M11.2 4.8 10 6M6 10l-1.2 1.2" /></Svg>
);
export const IconMessages = (p: P) => (
  <Svg {...p}><path d="M2.5 3.5h11v6.5h-7l-2.2 2V3.5Z" /><path d="M6 6h4M6 8h2.5" /></Svg>
);
export const IconBell = (p: P) => (
  <Svg {...p}><path d="M8 2.3c-1.8 0-3.1 1.4-3.1 3.4 0 1.9-.5 2.7-1.2 3.7h8.6c-.7-1-1.2-1.8-1.2-3.7 0-2-1.3-3.4-3.1-3.4Z" /><path d="M6.6 12.4a1.5 1.5 0 0 0 2.8 0" /></Svg>
);
export const IconCode = (p: P) => (
  <Svg {...p}><path d="M5 4.6 2.6 8 5 11.4M11 4.6 13.4 8 11 11.4M9.2 3.4 6.8 12.6" /></Svg>
);
export const IconShield = (p: P) => (
  <Svg {...p}><path d="M8 2 13 4v3.4c0 2.8-2 4.8-5 6.6-3-1.8-5-3.8-5-6.6V4z" /><path d="M6.1 8.1 7.6 9.6l2.3-2.7" /></Svg>
);
export const IconArchive = (p: P) => (
  <Svg {...p}><path d="M2.5 4.4h11v3h-11z" /><path d="M3.5 7.4V12h9V7.4" /><path d="M6.5 9.6h3" /></Svg>
);
export const IconNetwork = (p: P) => (
  <Svg {...p}><circle cx="3" cy="8" r="1.6" /><circle cx="13" cy="8" r="1.6" /><circle cx="8" cy="3" r="1.6" /><circle cx="8" cy="13" r="1.6" /><path d="M4.3 6.7 6.7 4.3M9.3 4.3 11.7 6.7M4.3 9.3 6.7 11.7M9.3 11.7 11.7 9.3" /></Svg>
);
