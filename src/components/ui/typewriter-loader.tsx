/** Shared loading state. No visible copy; the status stays accessible. */
export function TypewriterLoader({
  contained = false,
}: {
  contained?: boolean;
}) {
  return (
    <div
      className={`typewriter-loading${contained ? " typewriter-loading--contained" : ""}`}
      role="status"
      aria-label="Loading"
    >
      <svg
        className="typewriter-loader"
        viewBox="0 0 320 240"
        aria-hidden="true"
        focusable="false"
      >
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M66 119H254" />
          <path d="M96 133V119M224 133V119" />
        </g>
        <g fill="currentColor">
          <rect x="84" y="211" width="28" height="6" rx="3" />
          <rect x="208" y="211" width="28" height="6" rx="3" />
        </g>

        <g className="typewriter-carriage">
          <rect
            x="112"
            y="35"
            width="92"
            height="70"
            rx="4"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            d="M190 35V49H204"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          <rect
            x="78"
            y="96"
            width="158"
            height="13"
            rx="6.5"
            fill="currentColor"
          />
          <path
            d="M64 102H78M236 102H248"
            stroke="currentColor"
            strokeWidth="4"
          />
          <rect
            x="57"
            y="95"
            width="8"
            height="15"
            rx="3"
            fill="currentColor"
          />
          <rect
            x="248"
            y="95"
            width="8"
            height="15"
            rx="3"
            fill="currentColor"
          />
          <path
            d="M87 95V83H63"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        <path
          d="M147 123L151 112H169L173 123"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path
          className="typewriter-typebar"
          d="M160 124V106"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />

        <path
          d="M97 130H223Q232 130 236 141L254 196Q258 209 245 209H75Q62 209 66 196L84 141Q88 130 97 130Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinejoin="round"
        />
        <path
          d="M96 141H224"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <rect
          className="typewriter-key typewriter-key-1"
          x="98"
          y="156"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-2"
          x="118"
          y="156"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-3"
          x="138"
          y="156"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-4"
          x="158"
          y="156"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-5"
          x="178"
          y="156"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-6"
          x="198"
          y="156"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-7"
          x="218"
          y="156"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-8"
          x="108"
          y="176"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-9"
          x="128"
          y="176"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-10"
          x="148"
          y="176"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-11"
          x="168"
          y="176"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-12"
          x="188"
          y="176"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          className="typewriter-key typewriter-key-13"
          x="208"
          y="176"
          width="13"
          height="10"
          rx="3"
          fill="currentColor"
        />
        <rect
          x="124"
          y="193"
          width="72"
          height="6"
          rx="3"
          fill="currentColor"
        />
      </svg>
    </div>
  );
}
