// Saves the wallpaper window only: a whole-panorama view plus a sharp crop of the cloud band.
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
static class G {
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW([MarshalAs(UnmanagedType.LPWStr)] string c,[MarshalAs(UnmanagedType.LPWStr)] string t);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr p,IntPtr a,[MarshalAs(UnmanagedType.LPWStr)] string c,[MarshalAs(UnmanagedType.LPWStr)] string t);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
 struct R { public int L,T,Ri,B; }
 // args: <prefix> [cropX cropY cropW cropH]
 static void Main(string[] a){
  SetProcessDPIAware();
  IntPtr pm=FindWindowW("Progman",null); IntPtr w=FindWindowExW(pm,IntPtr.Zero,"Chrome_WidgetWin_1",null);
  if(w==IntPtr.Zero){Console.WriteLine("wallpaper window not found");return;}
  R r; GetWindowRect(w,out r); int W=r.Ri-r.L,H=r.B-r.T;
  int cx=a.Length>1?int.Parse(a[1]):1300, cy=a.Length>2?int.Parse(a[2]):150, cw=a.Length>3?int.Parse(a[3]):1400, ch=a.Length>4?int.Parse(a[4]):560;
  using(var b=new Bitmap(W,H)) using(var g=Graphics.FromImage(b)){
   IntPtr dc=g.GetHdc(); PrintWindow(w,dc,2); g.ReleaseHdc(dc);
   using(var s=new Bitmap(1920,540)) using(var g2=Graphics.FromImage(s)){ g2.InterpolationMode=System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g2.DrawImage(b,0,0,1920,540); s.Save(a[0]+"-full.jpg",ImageFormat.Jpeg);}
   using(var c=b.Clone(new Rectangle(cx,cy,cw,ch),b.PixelFormat)) c.Save(a[0]+"-crop.png",ImageFormat.Png);
  }
  Console.WriteLine("saved "+a[0]);
 }
}
