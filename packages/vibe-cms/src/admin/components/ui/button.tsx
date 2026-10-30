import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[10px] text-sm font-medium whitespace-nowrap transition-[scale,box-shadow,background-color,color,opacity] duration-150 ease-out outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Tactile: raised at rest, a touch more lift on hover, pushed in while pressed or open.
        default: "raised-brand hover:brightness-[1.06] active:brightness-95 aria-expanded:brightness-95",
        outline:
          "raised text-foreground hover:shadow-(--shadow-raised-hover) active:pressed aria-expanded:pressed",
        secondary:
          "raised text-foreground hover:shadow-(--shadow-raised-hover) active:pressed aria-expanded:pressed",
        ghost:
          "text-foreground hover:bg-foreground/[0.05] active:pressed aria-expanded:bg-foreground/[0.06]",
        destructive:
          "raised text-destructive hover:shadow-(--shadow-raised-hover) active:pressed focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[8px] px-2 text-xs  has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[9px] px-2.5 text-[0.8rem]  has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[8px]  [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[9px] ",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
