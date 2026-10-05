export default function Layout({ children }: { children: unknown }) { return <html>{children as never}</html>; }
