using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Text;
static class P {
 delegate bool E(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(E e, IntPtr l);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW([MarshalAs(UnmanagedType.LPWStr)] string c,[MarshalAs(UnmanagedType.LPWStr)] string t);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 struct R { public int L,T,Ri,B; }
 static string Cls(IntPtr h){ var s=new StringBuilder(128); GetClassNameW(h,s,128); return s.ToString(); }
 static string Txt(IntPtr h){ var s=new StringBuilder(128); GetWindowTextW(h,s,128); return s.ToString(); }
 static void Main(){
  Console.WriteLine("Progman children:");
  IntPtr pm=FindWindowW("Progman",null); IntPtr c=GetWindow(pm,5);
  while(c!=IntPtr.Zero){ R r; GetWindowRect(c,out r); Console.WriteLine("  "+Cls(c)+" '"+Txt(c)+"' visible="+IsWindowVisible(c)+" rect="+r.L+","+r.T+","+r.Ri+","+r.B); c=GetWindow(c,2); }
  IntPtr fg=GetForegroundWindow(); Console.WriteLine("Foreground: "+Cls(fg)+" '"+Txt(fg)+"'");
  Console.WriteLine("Top-level Chrome_WidgetWin windows of msedge:");
  EnumWindows(delegate(IntPtr h, IntPtr l){ uint p; GetWindowThreadProcessId(h,out p); string n=""; try{n=Process.GetProcessById((int)p).ProcessName;}catch{} if(n!="msedge") return true; R r; GetWindowRect(h,out r); Console.WriteLine("  pid="+p+" "+Cls(h)+" '"+Txt(h)+"' visible="+IsWindowVisible(h)+" iconic="+IsIconic(h)+" rect="+r.L+","+r.T+","+r.Ri+","+r.B); return true; }, IntPtr.Zero);
 }
}
