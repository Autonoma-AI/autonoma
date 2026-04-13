export const Temporal = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 32 32"
    height="32"
    width="32"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="16" cy="16" r="16" fill="#141414" />
    <path d="M16 6a10 10 0 100 20 10 10 0 000-20zm0 2.5a7.5 7.5 0 110 15 7.5 7.5 0 010-15z" fill="#fff" />
    <circle cx="16" cy="16" r="3" fill="#fff" />
    <rect x="15" y="8.5" width="2" height="7.5" rx="1" fill="#fff" />
  </svg>
);
