import AppKit
import SwiftUI
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
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
                .frame(minWidth: 740, idealWidth: 780, minHeight: 720, idealHeight: 840)
        }
        .defaultSize(width: 780, height: 840)
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
