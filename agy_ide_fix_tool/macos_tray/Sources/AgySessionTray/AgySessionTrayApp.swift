import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
    }
}

@main
struct AgySessionTrayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var viewModel = StatusViewModel()

    var body: some Scene {
        WindowGroup("Antigravity Sessions") {
            DashboardView()
                .environmentObject(viewModel)
                .frame(minWidth: 740, idealWidth: 780, minHeight: 560, idealHeight: 620)
        }
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
