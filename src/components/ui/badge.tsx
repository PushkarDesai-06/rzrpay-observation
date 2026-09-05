import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * Semantic tones share one recipe: a soft tinted fill, an inset ring of the
 * same hue, and an optional glowing dot. The hue is exposed as `--dot` so the
 * indicator picks up the variant without a second class list.
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
        emerald:
          "[--dot:var(--color-emerald-400)] bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20",
        amber:
          "[--dot:var(--color-amber-400)] bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-400/20",
        rose: "[--dot:var(--color-rose-400)] bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-400/20",
        sky: "[--dot:var(--color-sky-400)] bg-sky-500/10 text-sky-300 ring-1 ring-inset ring-sky-400/20",
        violet:
          "[--dot:var(--color-violet-400)] bg-violet-500/10 text-violet-300 ring-1 ring-inset ring-violet-400/20",
        slate:
          "[--dot:var(--color-slate-400)] bg-white/4 text-slate-400 ring-1 ring-inset ring-white/8",
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
  dot = false,
  pulse = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
    /** Leading glowing indicator in the variant's hue. */
    dot?: boolean | undefined
    /** Animate the dot; use for states the loop is still working on. */
    pulse?: boolean | undefined
  }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-(--dot) shadow-[0_0_6px_1px_var(--dot)]",
            pulse && "animate-pulse"
          )}
        />
      ) : null}
      {children}
    </Comp>
  )
}

export { Badge, badgeVariants, type BadgeVariant }
