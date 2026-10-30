"use client"


import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useIsDark } from "../../app/theme"

const Toaster = ({ ...props }: ToasterProps) => {
  // The editor's own light/dark choice, which can differ from the system's.
  const theme = useIsDark() ? "dark" : "light"

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "14px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // The floating material, like menus and dialogs.
          toast: "cn-toast !border-0 !shadow-(--shadow-float)",
          actionButton: "!h-7 !rounded-[8px] !bg-foreground !px-2.5 !font-medium !text-background",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
