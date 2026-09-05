import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * Semantic tones share one recipe: a soft tinted fill, an inset ring of the
 * same hue, and text in a lighter step of that hue. Colour alone carries state.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border border-transparent px-1.5 py-px text-[10.5px] font-medium tracking-wide whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        emerald: "bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20",
        amber: "bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-400/20",
        rose: "bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/20",
        sky: "bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-400/20",
        violet: "bg-violet-500/10 text-violet-300 ring-1 ring-inset ring-violet-400/20",
        slate: "bg-white/4 text-slate-400 ring-1 ring-inset ring-white/8",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

function Badge({
  className,
  variant = "default",
  asChild = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {children}
    </Comp>
  )
}

export { Badge, badgeVariants, type BadgeVariant }
