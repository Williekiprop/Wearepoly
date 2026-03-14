import * as React from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Terminal-styled customized UI components

export const TerminalCard = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("bg-card border border-border/50 rounded-xl overflow-hidden shadow-lg", className)} {...props} />
));
TerminalCard.displayName = "TerminalCard";

export const TerminalCardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("px-4 py-3 border-b border-border/50 bg-secondary/30 flex items-center justify-between", className)} {...props} />
));
TerminalCardHeader.displayName = "TerminalCardHeader";

export const TerminalCardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, ...props }, ref) => (
  <h3 ref={ref} className={cn("text-xs font-bold tracking-wider text-muted-foreground uppercase flex items-center gap-2", className)} {...props} />
));
TerminalCardTitle.displayName = "TerminalCardTitle";

export const TerminalCardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-4", className)} {...props} />
));
TerminalCardContent.displayName = "TerminalCardContent";

export const ValueDisplay = ({ label, value, subValue, highlight = "none", className }: { label: string, value: React.ReactNode, subValue?: React.ReactNode, highlight?: "none" | "success" | "danger" | "warning" | "primary", className?: string }) => {
  const highlightColors = {
    none: "text-foreground",
    success: "text-success text-glow-success",
    danger: "text-destructive text-glow-destructive",
    warning: "text-warning text-glow-warning",
    primary: "text-primary box-glow-primary",
  };

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-xl md:text-2xl font-mono font-bold tracking-tight", highlightColors[highlight])}>
          {value}
        </span>
        {subValue && <span className="text-xs font-mono text-muted-foreground">{subValue}</span>}
      </div>
    </div>
  );
};

export const TerminalButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "outline" | "danger" | "ghost", size?: "default" | "sm" | "lg" }>(
  ({ className, variant = "default", size = "default", ...props }, ref) => {
    const variants = {
      default: "bg-primary/10 text-primary border-primary/50 hover:bg-primary/20 hover:border-primary hover:shadow-[0_0_15px_rgba(52,211,153,0.3)]",
      outline: "bg-transparent text-foreground border-border hover:bg-secondary hover:border-muted-foreground",
      danger: "bg-destructive/10 text-destructive border-destructive/50 hover:bg-destructive/20 hover:border-destructive hover:shadow-[0_0_15px_rgba(248,113,113,0.3)]",
      ghost: "bg-transparent text-muted-foreground border-transparent hover:text-foreground hover:bg-secondary/50"
    };
    
    const sizes = {
      default: "h-10 px-4 py-2 text-sm",
      sm: "h-8 px-3 text-xs",
      lg: "h-12 px-8 text-base"
    };

    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md border font-mono font-medium transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);
TerminalButton.displayName = "TerminalButton";

export const TerminalBadge = ({ children, variant = "default", className }: { children: React.ReactNode, variant?: "default" | "success" | "danger" | "warning", className?: string }) => {
  const variants = {
    default: "bg-secondary text-secondary-foreground border-border",
    success: "bg-success/10 text-success border-success/30",
    danger: "bg-destructive/10 text-destructive border-destructive/30",
    warning: "bg-warning/10 text-warning border-warning/30",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-mono font-semibold transition-colors", variants[variant], className)}>
      {children}
    </span>
  );
};
