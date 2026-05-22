export const Temporal = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    height="16"
    width="16"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <ellipse cx="16" cy="16" rx="13" ry="6" fill="none" stroke="currentColor" strokeWidth="2.5" />
    <ellipse cx="16" cy="16" rx="6" ry="13" fill="none" stroke="currentColor" strokeWidth="2.5" />
  </svg>
);
