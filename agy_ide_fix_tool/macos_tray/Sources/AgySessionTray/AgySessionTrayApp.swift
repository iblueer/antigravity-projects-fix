import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
}

struct WindowSizeEnforcer: NSViewRepresentable {
    let idealSize: CGSize
    let minimumSize: CGSize

    final class Coordinator {
        var didConfigure = false
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async {
            configure(window: view.window, coordinator: context.coordinator)
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async {
            configure(window: view.window, coordinator: context.coordinator)
        }
    }

    private func configure(window: NSWindow?, coordinator: Coordinator) {
        guard let window else { return }
        window.minSize = minimumSize
        window.isRestorable = false
        guard !coordinator.didConfigure else { return }
        coordinator.didConfigure = true

        let visibleFrame = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        let targetWidth = min(idealSize.width, max(visibleFrame.width - 40, minimumSize.width))
        let targetHeight = min(idealSize.height, max(visibleFrame.height - 40, minimumSize.height))

        let widthDelta = abs(window.frame.width - targetWidth)
        let heightDelta = abs(window.frame.height - targetHeight)
        guard widthDelta > 24 || heightDelta > 24 else { return }

        var frame = window.frame
        frame.size.width = targetWidth
        frame.size.height = targetHeight
        if !visibleFrame.isEmpty {
            frame.origin.x = visibleFrame.midX - targetWidth / 2
            frame.origin.y = visibleFrame.midY - targetHeight / 2
        }
        window.setFrame(frame, display: true)
    }
}

@main
struct AgySessionTrayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var viewModel = StatusViewModel()

    var body: some Scene {
        WindowGroup("Antigravity Sessions", id: "main") {
            DashboardView()
                .environmentObject(viewModel)
                .frame(minWidth: 780, idealWidth: 860, minHeight: 620, idealHeight: 648)
                .background(
                    WindowSizeEnforcer(
                        idealSize: CGSize(width: 860, height: 648),
                        minimumSize: CGSize(width: 780, height: 620)
                    )
                )
        }
        .defaultSize(width: 860, height: 648)
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            MenuStatusView()
                .environmentObject(viewModel)
        } label: {
            Image(systemName: viewModel.statusIcon)
        }
        .menuBarExtraStyle(.window)
    }
}
