"use client"

import * as React from "react"
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

/**
 * The area that answers a right-click.
 *
 * `render` rather than a wrapper element, so the trigger does not add a box
 * between a scroll container and its rows.
 */
function ContextMenuTrigger({ ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuContent({ className, ...props }: MenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-50">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "z-50 min-w-[188px] origin-(--transform-origin) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { variant?: "default" | "danger" }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-variant={variant}
      className={cn(
        "flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] outline-hidden transition-colors",
        "data-highlighted:bg-secondary data-highlighted:text-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-40",
        variant === "danger" &&
          "text-danger-ink data-highlighted:bg-danger/12 data-highlighted:text-danger-ink",
        className
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-line", className)}
      {...props}
    />
  )
}

/** The keyboard hint on the right of a row: ⌘R, Del, F2. */
function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn("ml-auto pl-4 text-[11px] tracking-wide text-faint", className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
}
