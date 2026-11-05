"use client"

import * as React from "react"
import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu"
import { cn } from "../../lib/utils"

/**
 * A row of triggers that each open a panel. One popup is shared by all of them: it follows the active trigger, resizes
 * to the panel it holds, and the panels slide past one another in the direction you moved.
 */
function NavigationMenu({
  className,
  children,
  alignOffset,
  ...props
}: NavigationMenuPrimitive.Root.Props & { alignOffset?: number }) {
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      className={cn("relative flex min-w-0 items-center", className)}
      {...props}
    >
      {children}
      <NavigationMenuViewport alignOffset={alignOffset} />
    </NavigationMenuPrimitive.Root>
  )
}

function NavigationMenuList({
  className,
  ...props
}: NavigationMenuPrimitive.List.Props) {
  return (
    <NavigationMenuPrimitive.List
      data-slot="navigation-menu-list"
      className={cn("flex min-w-0 list-none items-center gap-0.5", className)}
      {...props}
    />
  )
}

function NavigationMenuItem({
  className,
  ...props
}: NavigationMenuPrimitive.Item.Props) {
  return (
    <NavigationMenuPrimitive.Item
      data-slot="navigation-menu-item"
      className={cn("relative shrink-0", className)}
      {...props}
    />
  )
}

function NavigationMenuTrigger({
  className,
  ...props
}: NavigationMenuPrimitive.Trigger.Props) {
  return (
    <NavigationMenuPrimitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn("group/trigger", className)}
      {...props}
    />
  )
}

function NavigationMenuContent({
  className,
  ...props
}: NavigationMenuPrimitive.Content.Props) {
  return (
    <NavigationMenuPrimitive.Content
      data-slot="navigation-menu-content"
      className={cn(
        "w-max transition-[opacity,translate] duration-200 ease-out",
        "data-starting-style:opacity-0 data-ending-style:opacity-0",
        "data-[starting-style]:data-[activation-direction=left]:-translate-x-10 data-[starting-style]:data-[activation-direction=right]:translate-x-10",
        "data-[ending-style]:data-[activation-direction=left]:translate-x-10 data-[ending-style]:data-[activation-direction=right]:-translate-x-10",
        className
      )}
      {...props}
    />
  )
}

function NavigationMenuLink({
  className,
  ...props
}: NavigationMenuPrimitive.Link.Props) {
  return (
    <NavigationMenuPrimitive.Link
      data-slot="navigation-menu-link"
      className={className}
      {...props}
    />
  )
}

/**
 * Above the page and the floating preview window, like the other popups.
 *
 * The menu's size and position animate together. Its position is given (`alignOffset`) from the width it is growing to,
 * not found by collision detection, which would see the width mid-animation, lag it, and let the menu poke past the
 * window's edge on the way.
 */
function NavigationMenuViewport({ alignOffset = 0 }: { alignOffset?: number }) {
  return (
    <NavigationMenuPrimitive.Portal>
      <NavigationMenuPrimitive.Positioner
        align="start"
        alignOffset={alignOffset}
        sideOffset={6}
        collisionPadding={12}
        collisionAvoidance={{ side: "none", align: "none" }}
        positionMethod="fixed"
        className="isolate z-50 transition-[top,left] duration-200 ease-out data-instant:transition-none"
      >
        <NavigationMenuPrimitive.Popup
          data-slot="navigation-menu-popup"
          className="relative h-(--popup-height) w-(--popup-width) max-w-(--available-width) origin-(--transform-origin) overflow-hidden rounded-[20px] floating text-popover-foreground outline-hidden transition-[opacity,scale,width,height] duration-200 ease-out data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0"
        >
          <NavigationMenuPrimitive.Viewport className="relative h-full w-full overflow-hidden" />
        </NavigationMenuPrimitive.Popup>
      </NavigationMenuPrimitive.Positioner>
    </NavigationMenuPrimitive.Portal>
  )
}

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink
}
