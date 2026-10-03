//! The driven line (web `routes/shared/line.ts`): samples every few metres
//! with their height and the ploughed half width, the arc length along
//! them, the point at an arc length and the arc length and offset of a
//! point near a known segment. Offsets are positive to the right of travel.
//! Positions are f64: the line runs tens of kilometres from the origin.

pub struct Line {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
    pub half: Vec<f64>,
    /// Arc length at every sample.
    pub s: Vec<f64>,
    pub length: f64,
}

#[derive(Clone, Copy, Default)]
pub struct LinePoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Unit tangent in the ground plane.
    pub tx: f64,
    pub tz: f64,
    /// Rise per metre.
    pub grade: f64,
}

#[derive(Clone, Copy, Default)]
pub struct Projection {
    pub s: f64,
    pub d: f64,
    pub i: usize,
}

impl Line {
    /// From the pack's `LINE` section: count × { x, y, z, half width } f32.
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        let n = bytes.len() / 16;
        let f = |i: usize, k: usize| f32::from_le_bytes(bytes[i * 16 + k * 4..i * 16 + k * 4 + 4].try_into().unwrap());
        Self::new((0..n).map(|i| f(i, 0) as f64).collect(), (0..n).map(|i| f(i, 1) as f64).collect(), (0..n).map(|i| f(i, 2) as f64).collect(), (0..n).map(|i| f(i, 3) as f64).collect())
    }

    /// From samples and the half width at each.
    pub fn new(x: Vec<f64>, y: Vec<f64>, z: Vec<f64>, half: Vec<f64>) -> Result<Self, String> {
        let n = x.len();
        if n < 2 || y.len() != n || z.len() != n || half.len() != n {
            return Err("route: the driven line is empty".into());
        }
        let mut s = Vec::with_capacity(n);
        for i in 0..n {
            s.push(if i == 0 { 0.0 } else { s[i - 1] + (x[i] - x[i - 1]).hypot(z[i] - z[i - 1]) });
        }
        let length = s[n - 1];
        Ok(Self { x, y, z, half, s, length })
    }

    pub fn n(&self) -> usize {
        self.x.len()
    }

    /// Segment holding arc length `s`.
    pub fn segment(&self, s: f64) -> usize {
        let (mut lo, mut hi) = (0usize, self.n() - 2);
        while lo < hi {
            let m = (lo + hi + 1) / 2;
            if self.s[m] <= s {
                lo = m;
            } else {
                hi = m - 1;
            }
        }
        lo
    }

    /// The point at arc length `s` (clamped), its tangent and grade.
    pub fn at(&self, s: f64) -> LinePoint {
        let c = s.clamp(0.0, self.length);
        let i = self.segment(c);
        let len = self.s[i + 1] - self.s[i];
        let len = if len == 0.0 { 1.0 } else { len };
        let t = (c - self.s[i]) / len;
        let a = i.saturating_sub(1);
        let b = (i + 2).min(self.n() - 1);
        let unit = |dx: f64, dz: f64| {
            let l = dx.hypot(dz);
            let l = if l == 0.0 { 1.0 } else { l };
            (dx / l, dz / l)
        };
        let (t0x, t0z) = unit(self.x[i + 1] - self.x[a], self.z[i + 1] - self.z[a]);
        let (t1x, t1z) = unit(self.x[b] - self.x[i], self.z[b] - self.z[i]);
        let (tx, tz) = unit(t0x + (t1x - t0x) * t, t0z + (t1z - t0z) * t);
        LinePoint {
            x: self.x[i] + (self.x[i + 1] - self.x[i]) * t,
            y: self.y[i] + (self.y[i + 1] - self.y[i]) * t,
            z: self.z[i] + (self.z[i + 1] - self.z[i]) * t,
            tx,
            tz,
            grade: (self.y[i + 1] - self.y[i]) / len,
        }
    }

    /// Ploughed half width at an arc length.
    pub fn half_at(&self, s: f64) -> f64 {
        self.half[self.segment(s.clamp(0.0, self.length))]
    }

    /// Nearest point among the segments around `hint`.
    pub fn track(&self, x: f64, z: f64, hint: usize, span: usize) -> Projection {
        let mut out = Projection::default();
        let mut best = f64::INFINITY;
        let a = hint.saturating_sub(span);
        let b = (hint + span).min(self.n() - 2);
        for i in a..=b {
            let (ax, az) = (self.x[i], self.z[i]);
            let (dx, dz) = (self.x[i + 1] - ax, self.z[i + 1] - az);
            let l2 = dx * dx + dz * dz;
            let l2 = if l2 == 0.0 { 1.0 } else { l2 };
            let t = (((x - ax) * dx + (z - az) * dz) / l2).clamp(0.0, 1.0);
            let (ex, ez) = (x - (ax + dx * t), z - (az + dz * t));
            let d2 = ex * ex + ez * ez;
            if d2 < best {
                best = d2;
                let side = -dz * ex + dx * ez;
                out = Projection { s: self.s[i] + l2.sqrt() * t, d: if side > 0.0 { d2.sqrt() } else if side < 0.0 { -d2.sqrt() } else { 0.0 }, i };
            }
        }
        out
    }

    /// Nearest sample to a point anywhere on the line (a camera placed by a control message).
    pub fn nearest(&self, x: f64, z: f64) -> usize {
        let mut best = (f64::INFINITY, 0);
        for i in 0..self.n() {
            let d2 = (self.x[i] - x).powi(2) + (self.z[i] - z).powi(2);
            if d2 < best.0 {
                best = (d2, i);
            }
        }
        best.1
    }
}
