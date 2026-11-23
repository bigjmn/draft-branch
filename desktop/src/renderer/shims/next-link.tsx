/** Stands in for next/link in the shared components. */
import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../router";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
};
export default function Link({ href, onClick, target, ...rest }: Props) {
  return (
    <a
      {...rest}
      href={href}
      target={target}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          target ||
          !href.startsWith("/")
        )
          return;
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}
